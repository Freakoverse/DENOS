//! NIP-SKD — Sub-Key Derivation (scheme salt `"nip-skd-v1"`).
//!
//! Deterministic derivation of application-scoped keys from the user's identity key, and
//! operating as those sub-keys without ever exposing their private material. All forms use
//! HKDF-SHA256 under the fixed salt `"nip-skd-v1"`, with a **form-tagged** info string
//! `info = "nip-skd:" ‖ form ‖ 0x1F ‖ context` (§1) so no two forms share a seed on the same
//! inputs. Three forms:
//!   - self    : IKM = root_priv                                   → seed·G           (independent key)
//!   - shared  : IKM = raw ECDH x-coord(root_priv, peer)           → seed·G           (both parties derive it)
//!   - blinded : IKM = raw ECDH x-coord(root_priv, peer), base-bound → root_pub + seed·G (peer verifies, can't sign)
//!
//! The 48-byte HKDF output is wide-reduced mod n (unbiased) to a secp256k1 scalar. For self/shared
//! it IS the sub-key private scalar; for blinded it is the tweak `t` added to the even-y-normalized
//! root key. `ecdh_x` is the RAW x-coordinate (as NIP-44 uses), NOT sha256(x). See
//! `DEN Chat/docs/v2/NIP-SKD.md`. Verified against the spec's §8 test vectors (see tests below).
//!
//! Security invariant: never expose the seed, any sub-key/blinded private key, or the raw ECDH
//! result — only the operations that USE the key (get pubkey / sign / nip44 / nip04). A blinded
//! private key (`root_priv + t`) is ROOT-EQUIVALENT (the peer knows `t`), so it is held at the
//! same security level as the root key and never leaves the signer.

use hkdf::Hkdf;
use nostr_sdk::prelude::{Keys, SecretKey};
use nostr_sdk::secp256k1::ecdh::shared_secret_point;
use nostr_sdk::secp256k1::{
    Parity, PublicKey as SecpPublicKey, Scalar, Secp256k1, SecretKey as SecpSecretKey,
    XOnlyPublicKey,
};
use num_bigint::BigUint;
use sha2::Sha256;

const SKD_SALT: &[u8] = b"nip-skd-v1";
/// secp256k1 group order n.
const SECP256K1_N_HEX: &[u8] = b"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141";

/// Form-tagged HKDF `info`: `"nip-skd:" ‖ form ‖ 0x1F ‖ context` (§1). The `0x1F` unit separator is a
/// single raw byte; the tag makes the form/context boundary unforgeable so no two forms share a seed.
/// Used by the `self` and `shared` forms. The `blinded` form uses [`skd_info_blinded`] instead.
fn skd_info(form: &str, context: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + form.len() + 1 + context.len());
    v.extend_from_slice(b"nip-skd:");
    v.extend_from_slice(form.as_bytes());
    v.push(0x1F);
    v.extend_from_slice(context.as_bytes());
    v
}

/// Blinded-form HKDF `info`: `"nip-skd:blinded" ‖ 0x1F ‖ base(32 raw bytes) ‖ context` (§1).
///
/// `base` is the x-only pubkey of the key being blinded, folded in as **32 RAW bytes** (not hex
/// text), BEFORE the context. It is fixed-width, so there is NO separator between it and the
/// context. Binding the base is a privacy fix: without it the tweak depended only on
/// `(ecdh_x, context)`, so a key and its reverse-direction blinding (A→B vs B→A) — which share one
/// ECDH x-coordinate and one context — produced the SAME tweak and the SAME offset `t·G`, letting a
/// passive observer link both masked keys to their roots once a conversation was answered
/// (`M − S == M_reply − R`, all four points public). Folding `base` in breaks that symmetry.
fn skd_info_blinded(base_xonly: &[u8; 32], context: &str) -> Vec<u8> {
    let mut v = Vec::with_capacity(15 + 1 + 32 + context.len());
    v.extend_from_slice(b"nip-skd:blinded");
    v.push(0x1F);
    v.extend_from_slice(base_xonly);
    v.extend_from_slice(context.as_bytes());
    v
}

/// Decode a 32-byte root private key from hex.
fn decode_root_priv(root_priv_hex: &str) -> Result<Vec<u8>, String> {
    let root_priv = hex::decode(root_priv_hex).map_err(|e| format!("NIP-SKD: bad root priv: {e}"))?;
    if root_priv.len() != 32 {
        return Err("NIP-SKD: root priv must be 32 bytes".to_string());
    }
    Ok(root_priv)
}

/// Raw ECDH x-coordinate (32 bytes) between `root_priv` and an x-only `peer` (reconstructed even-y).
/// This is the value NIP-44 feeds its KDF — NOT `sha256(x)`.
fn ecdh_x(root_priv: &[u8], peer_pub_hex: &str) -> Result<[u8; 32], String> {
    let sk = SecpSecretKey::from_slice(root_priv).map_err(|e| format!("NIP-SKD: bad root priv: {e}"))?;
    let peer_bytes = hex::decode(peer_pub_hex).map_err(|e| format!("NIP-SKD: bad peer pub: {e}"))?;
    let xonly =
        XOnlyPublicKey::from_slice(&peer_bytes).map_err(|e| format!("NIP-SKD: bad peer pub: {e}"))?;
    let peer_pk = SecpPublicKey::from_x_only_public_key(xonly, Parity::Even);
    // shared_secret_point → 64 bytes (x || y, big-endian); take the raw x-coordinate.
    let point = shared_secret_point(&peer_pk, &sk);
    let mut x = [0u8; 32];
    x.copy_from_slice(&point[..32]);
    Ok(x)
}

/// Wide-reduce a 48-byte HKDF output mod n with the `0 → 1` pin. The 128-bit margin over 256 bits
/// makes `mod n` unbiased by construction (§1). Returns a scalar in `[1, n-1]`.
fn reduce_seed(seed: &[u8; 48]) -> [u8; 32] {
    let n = BigUint::parse_bytes(SECP256K1_N_HEX, 16).unwrap();
    let mut reduced = BigUint::from_bytes_be(seed) % &n;
    if reduced.bits() == 0 {
        // ~2^-384 chance. Pin 0 → 1 so the derivation stays total and byte-identical to the
        // reference (skd.ts). For blinded, this pin is a hard requirement: t = 0 would make
        // blinded == root, leaking it.
        reduced = BigUint::from(1u8);
    }
    let rb = reduced.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - rb.len()..].copy_from_slice(&rb);
    out
}

/// HKDF-SHA256 (salt `"nip-skd-v1"`, explicit `info`, L = 48) → wide-reduce mod n. Returns a scalar
/// in `[1, n-1]`.
fn derive_scalar(ikm: &[u8], info: &[u8]) -> Result<[u8; 32], String> {
    let hk = Hkdf::<Sha256>::new(Some(SKD_SALT), ikm);
    let mut seed = [0u8; 48];
    hk.expand(info, &mut seed)
        .map_err(|_| "NIP-SKD: HKDF expand failed".to_string())?;
    Ok(reduce_seed(&seed))
}

/// Self/shared seed scalar: `reduce(HKDF(ikm, skd_info(form, context)))`.
fn derive_seed_scalar(ikm: &[u8], form: &str, context: &str) -> Result<[u8; 32], String> {
    derive_scalar(ikm, &skd_info(form, context))
}

/// Blinded tweak `t`: `reduce(HKDF(ecdh_x, skd_info_blinded(base, context)))`, with the x-only key
/// being blinded (`base`) bound into the info — see [`skd_info_blinded`] for why.
fn derive_blinded_tweak(ecdh_x: &[u8], base_xonly: &[u8; 32], context: &str) -> Result<[u8; 32], String> {
    derive_scalar(ecdh_x, &skd_info_blinded(base_xonly, context))
}

/// Derive the self/shared sub-key private scalar: `reduce(HKDF(IKM, info(form, context)))`, where
/// IKM = root_priv (self) or the raw ECDH x-coordinate (shared). `None`/empty peer ⇒ self form.
pub fn derive_subkey_scalar(
    root_priv_hex: &str,
    context: &str,
    peer_pub_hex: Option<&str>,
) -> Result<[u8; 32], String> {
    if context.is_empty() {
        return Err("NIP-SKD: context must be non-empty".to_string());
    }
    let root_priv = decode_root_priv(root_priv_hex)?;
    // Treat an empty peer string as self, matching the reference impl (JS `peerPubHex ? … : root`).
    match peer_pub_hex.filter(|s| !s.is_empty()) {
        None => derive_seed_scalar(&root_priv, "self", context),
        Some(peer) => {
            let x = ecdh_x(&root_priv, peer)?;
            derive_seed_scalar(&x, "shared", context)
        }
    }
}

/// Derive the self/shared sub-key as nostr `Keys`, for signing / nip44 / nip04 as the sub-key.
pub fn derive_subkey_keys(
    root_priv_hex: &str,
    context: &str,
    peer_pub_hex: Option<&str>,
) -> Result<Keys, String> {
    let scalar = derive_subkey_scalar(root_priv_hex, context, peer_pub_hex)?;
    let sk = SecretKey::from_hex(&hex::encode(scalar)).map_err(|e| format!("NIP-SKD: {e}"))?;
    Ok(Keys::new(sk))
}

/// Blinded derivation (§1), holder side — the caller's OWN blinded key toward `peer_pub`:
/// `blinded_priv = root_priv_evenY + t`, `blinded_pub = xonly(lift_even_y(root_pub) + t·G)`,
/// `t = reduce(HKDF(ecdh_x(root, peer), info_blinded(root_pub_xonly, context)))` — the base being
/// blinded (here the caller's own root pubkey) is bound into the info. Returns nostr `Keys` holding
/// `blinded_priv`; `keys.public_key()` is `blinded_pub`. A peer holding the other ECDH key can
/// re-derive `blinded_pub` (via `derive_blinded_pub_for_peer`) but never `blinded_priv`.
///
/// Even-y normalization (BIP-340/Taproot tweak rule): the tweak is added to `root_priv_evenY`
/// (`n − root_priv` when `root_pub` has odd y), so holder and verifier land on the same key.
pub fn derive_blinded_keys(
    root_priv_hex: &str,
    context: &str,
    peer_pub_hex: &str,
) -> Result<Keys, String> {
    if context.is_empty() {
        return Err("NIP-SKD: context must be non-empty".to_string());
    }
    if peer_pub_hex.is_empty() {
        return Err("NIP-SKD: blinded derivation requires a peer".to_string());
    }
    let root_priv = decode_root_priv(root_priv_hex)?;

    let secp = Secp256k1::new();
    let root_sk =
        SecpSecretKey::from_slice(&root_priv).map_err(|e| format!("NIP-SKD: bad root priv: {e}"))?;
    let root_pk = SecpPublicKey::from_secret_key(&secp, &root_sk);
    let (root_xonly, parity) = root_pk.x_only_public_key();
    // The key being blinded is the caller's own root pubkey; bind its x-only coordinate into the
    // tweak so A→B and B→A no longer collide (see `skd_info_blinded`).
    let base = root_xonly.serialize();

    let x = ecdh_x(&root_priv, peer_pub_hex)?;
    let t = derive_blinded_tweak(&x, &base, context)?; // in [1, n-1]
    // Normalize to the even-y representative (Taproot rule) so both sides agree.
    let sk_even = if parity == Parity::Odd { root_sk.negate() } else { root_sk };

    let t_scalar = Scalar::from_be_bytes(t).map_err(|_| "NIP-SKD: tweak out of range".to_string())?;
    let blinded_sk = match sk_even.add_tweak(&t_scalar) {
        Ok(sk) => sk,
        Err(_) => {
            // ~2^-256 edge (t ≡ -root_priv) → invalid 0 key. Pin blinded_priv 0 → 1 (§1).
            let mut one = [0u8; 32];
            one[31] = 1;
            SecpSecretKey::from_slice(&one).unwrap()
        }
    };

    let sk = SecretKey::from_slice(&blinded_sk.secret_bytes())
        .map_err(|e| format!("NIP-SKD: {e}"))?;
    Ok(Keys::new(sk))
}

/// Blinded derivation (§1), verifier side (`getPeerBlindedPubkey`) — a PEER's blinded pubkey toward
/// the caller: base = `peer_base` (the peer's key), blinded with `ecdh_x(caller_root, peer_base)`.
/// Returns the x-only public key hex ONLY; there is no private key on this side (the "verify but
/// cannot impersonate" property). By ECDH symmetry this equals the peer's own `derive_blinded_keys`
/// public key.
pub fn derive_blinded_pub_for_peer(
    root_priv_hex: &str,
    context: &str,
    peer_base_xonly_hex: &str,
) -> Result<String, String> {
    if context.is_empty() {
        return Err("NIP-SKD: context must be non-empty".to_string());
    }
    if peer_base_xonly_hex.is_empty() {
        return Err("NIP-SKD: blinded derivation requires a peer".to_string());
    }
    let root_priv = decode_root_priv(root_priv_hex)?;

    let secp = Secp256k1::new();
    let base_bytes =
        hex::decode(peer_base_xonly_hex).map_err(|e| format!("NIP-SKD: bad peer pub: {e}"))?;
    let base_xonly =
        XOnlyPublicKey::from_slice(&base_bytes).map_err(|e| format!("NIP-SKD: bad peer pub: {e}"))?;
    let base_even = SecpPublicKey::from_x_only_public_key(base_xonly, Parity::Even);
    // The key being blinded here is the peer arg; bind its x-only coordinate into the tweak. On the
    // holder side (`derive_blinded_keys`) this same key is the holder's root, so both sides fold in
    // the identical 32 bytes and still derive the same `t`. (See `skd_info_blinded`.)
    let base = base_xonly.serialize();

    let x = ecdh_x(&root_priv, peer_base_xonly_hex)?;
    let t = derive_blinded_tweak(&x, &base, context)?;

    let t_sk = SecpSecretKey::from_slice(&t).map_err(|e| format!("NIP-SKD: {e}"))?;
    let tg = SecpPublicKey::from_secret_key(&secp, &t_sk); // t·G
    let blinded = base_even
        .combine(&tg)
        .map_err(|e| format!("NIP-SKD: point add failed: {e}"))?;
    Ok(hex::encode(blinded.x_only_public_key().0.serialize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub_pub_hex(scalar: &[u8; 32]) -> String {
        Keys::new(SecretKey::from_hex(&hex::encode(scalar)).unwrap())
            .public_key()
            .to_hex()
    }

    const O_PUB: &str = "94576ae28a4583c68e5641b10befe9a90c92680271dc839052937a8552fc0ae5";
    const P_PUB: &str = "a02fa7340b804d26d55a6f4ae2efb4ad24c6d7a9c2568b7f30acf15a49adbca0";
    const R_MEMBER_PUB: &str = "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
    const MEMBER_CTX: &str = "nip-chat:v2:member-pseudonym:abc-123";
    const OWNER_CTX: &str = "nip-chat:v2:owner-pseudonym:abc-123";

    // §8 self derivation: NIP-CHAT owner pseudonym O (form-tagged info "nip-skd:self").
    #[test]
    fn vector_self() {
        let s = derive_subkey_scalar(&"11".repeat(32), OWNER_CTX, None).unwrap();
        assert_eq!(sub_pub_hex(&s), O_PUB);
    }

    // §8 shared derivation (independent key; NOT used by NIP-CHAT v2).
    #[test]
    fn vector_shared() {
        let s = derive_subkey_scalar(
            &"22".repeat(32),
            "nip-skd:example:shared:abc-123",
            Some(O_PUB),
        )
        .unwrap();
        assert_eq!(
            sub_pub_hex(&s),
            "96a9e601a6baa6acca538fad90d72ae3ed6906c5e057f6100e4a20b903611692"
        );
    }

    // §8 blinded derivation, holder side: member pseudonym P (member root 2222, peer = O_pub).
    #[test]
    fn vector_blinded_holder() {
        let keys = derive_blinded_keys(&"22".repeat(32), MEMBER_CTX, O_PUB).unwrap();
        assert_eq!(keys.public_key().to_hex(), P_PUB);
    }

    // §8 blinded symmetry / owner-verification: owner re-derives the same P via the verifier op
    // (base = R_member_pub, IKM = ecdh_x(O_priv, R_member_pub)), never learning P_priv.
    #[test]
    fn vector_blinded_symmetry() {
        // Sanity: member ROOT pubkey (of root 2222).
        let r_member_pub = Keys::new(SecretKey::from_hex(&"22".repeat(32)).unwrap())
            .public_key()
            .to_hex();
        assert_eq!(r_member_pub, R_MEMBER_PUB);

        // Owner pseudonym private scalar (self-derived from owner root 1111).
        let o_priv = derive_subkey_scalar(&"11".repeat(32), OWNER_CTX, None).unwrap();
        let p = derive_blinded_pub_for_peer(&hex::encode(o_priv), MEMBER_CTX, R_MEMBER_PUB).unwrap();
        assert_eq!(p, P_PUB);
    }

    // §8 blinded, odd-y base: root_priv whose root_pub has ODD y. Holder must tweak
    // root_priv_evenY = n - root_priv; both holder and verifier lift the even-y base and agree.
    #[test]
    fn vector_blinded_odd_y() {
        let root06 = format!("{:0>64}", "6"); // 00..06
        let root06_pub = "fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556";
        let expected = "e49ad6ea962a9dafe4c36b30eee07159b8690a967399c627368519c4963afdfb";

        // Sanity: root_pub of 00..06 is the odd-y key in the vector.
        // (Nostr Keys store the x-only even-y pubkey, so compare via secp compressed parity instead.)
        let secp = Secp256k1::new();
        let sk = SecpSecretKey::from_slice(&hex::decode(&root06).unwrap()).unwrap();
        let pk = SecpPublicKey::from_secret_key(&secp, &sk);
        assert_eq!(hex::encode(pk.x_only_public_key().0.serialize()), root06_pub);
        assert_eq!(pk.x_only_public_key().1, Parity::Odd);

        // Holder: blinded key of root06 toward O_pub.
        let holder = derive_blinded_keys(&root06, MEMBER_CTX, O_PUB).unwrap();
        assert_eq!(holder.public_key().to_hex(), expected);

        // Verifier: owner re-derives the same key with base = root06_pub.
        let o_priv = derive_subkey_scalar(&"11".repeat(32), OWNER_CTX, None).unwrap();
        let verifier =
            derive_blinded_pub_for_peer(&hex::encode(o_priv), MEMBER_CTX, root06_pub).unwrap();
        assert_eq!(verifier, expected);
    }

    // §8 facilitated pseudonym Pf: NESTED blinded — Pf blinds the facilitated member's R_f toward
    // the facilitator's own pseudonym P_fac (itself R_fac blinded toward O). Exercises a blinded
    // derivation whose peer is another blinded key, plus the verifier side using a DERIVED (non-root)
    // private key as the ECDH secret.
    #[test]
    fn vector_blinded_facilitated() {
        const P_FAC_PUB: &str = "96c8749a7596f1050e8245d81dee67d0c436ff10f46877abd07897a872043469";
        const PF_PUB: &str = "0b99f9978ac657619d0025fb8b5e4a6fdde3ecccc2b27d474e3f79e2ef2b0392";
        const FAC_CTX: &str = "nip-chat:v2:facilitated-pseudonym:abc-123";

        // Sanity: P_fac = R_fac(3333) blinded toward O_pub == the vector's stated P_fac_pub input.
        let p_fac = derive_blinded_keys(&"33".repeat(32), MEMBER_CTX, O_PUB).unwrap();
        assert_eq!(p_fac.public_key().to_hex(), P_FAC_PUB);

        // Facilitated side (the op a DENOS signer runs for the vouched user): R_f(4444) blinded
        // toward P_fac.
        let pf = derive_blinded_keys(&"44".repeat(32), FAC_CTX, P_FAC_PUB).unwrap();
        assert_eq!(pf.public_key().to_hex(), PF_PUB);

        // Facilitator verify: getPeerBlindedPubkey with the facilitator's DERIVED P_fac private key,
        // base = R_f_pub. ECDH symmetry ⇒ identical Pf, and Pf_priv is never obtained.
        let r_f_pub = Keys::new(SecretKey::from_hex(&"44".repeat(32)).unwrap())
            .public_key()
            .to_hex();
        let verify =
            derive_blinded_pub_for_peer(&p_fac.secret_key().to_secret_hex(), FAC_CTX, &r_f_pub)
                .unwrap();
        assert_eq!(verify, PF_PUB);
    }

    // Cross-check of the base-bound blinded primitive with a different holder root: the NIP-MDM
    // masked key M = S(root 1111) blinded toward R(pub of 2222), ctx "nip-mdm:v1:peer". Verifies
    // both the holder op and the recipient's verifier op (base = S_pub) land on the same M.
    #[test]
    fn vector_blinded_mdm_peer() {
        const MDM_CTX: &str = "nip-mdm:v1:peer";
        const M_PUB: &str = "e4fa4013c03848c3bdf8452c170d38885f4d0d25efa1c3da756b43768c444baf";

        // Holder: S (root 1111) blinds toward R_pub (pub of 2222 = R_MEMBER_PUB).
        let m = derive_blinded_keys(&"11".repeat(32), MDM_CTX, R_MEMBER_PUB).unwrap();
        assert_eq!(m.public_key().to_hex(), M_PUB);

        // Recipient verify: base = S_pub (the key being blinded = holder's root pub), ECDH secret =
        // r_priv (2222). ECDH symmetry ⇒ identical M, no private key obtained.
        let s_pub = Keys::new(SecretKey::from_hex(&"11".repeat(32)).unwrap())
            .public_key()
            .to_hex();
        let verify = derive_blinded_pub_for_peer(&"22".repeat(32), MDM_CTX, &s_pub).unwrap();
        assert_eq!(verify, M_PUB);
    }

    #[test]
    fn empty_context_rejected() {
        assert!(derive_subkey_scalar(&"11".repeat(32), "", None).is_err());
        assert!(derive_blinded_keys(&"22".repeat(32), "", O_PUB).is_err());
        assert!(derive_blinded_pub_for_peer(&"11".repeat(32), "", O_PUB).is_err());
    }

    #[test]
    fn blinded_requires_peer() {
        assert!(derive_blinded_keys(&"22".repeat(32), MEMBER_CTX, "").is_err());
    }
}
