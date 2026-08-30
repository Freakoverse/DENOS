//! NIP-SKD — Sub-Key Derivation (scheme salt `"nip-skd-v1"`).
//!
//! Deterministic derivation of application-scoped keys from the user's identity key, and
//! operating as those sub-keys without ever exposing their private material. Two forms, both
//! HKDF-SHA256 under the fixed salt `"nip-skd-v1"`, info = a public `context` string:
//!   - self  : IKM = root_priv
//!   - shared: IKM = raw ECDH x-coordinate(root_priv, peer_pub)  (as NIP-44 uses — NOT sha256(x))
//!
//! The 48-byte HKDF output is wide-reduced mod n (unbiased) to a secp256k1 scalar. See
//! `DEN Chat/docs/v2/NIP-SKD.md`. Verified against the spec's §8 test vectors (see tests below).
//!
//! Security invariant: never expose the seed, the sub-key private key, or the raw ECDH result —
//! only the operations that USE the sub-key (get pubkey / sign / nip44 / nip04).

use hkdf::Hkdf;
use nostr_sdk::prelude::{Keys, SecretKey};
use nostr_sdk::secp256k1::ecdh::shared_secret_point;
use nostr_sdk::secp256k1::{Parity, PublicKey as SecpPublicKey, SecretKey as SecpSecretKey, XOnlyPublicKey};
use num_bigint::BigUint;
use sha2::Sha256;

const SKD_SALT: &[u8] = b"nip-skd-v1";
/// secp256k1 group order n.
const SECP256K1_N_HEX: &[u8] = b"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141";

/// Derive the 32-byte sub-key private scalar from the root private key (hex), a non-empty
/// `context`, and — for shared derivations — a peer x-only pubkey (hex). `None` peer = self form.
pub fn derive_subkey_scalar(
    root_priv_hex: &str,
    context: &str,
    peer_pub_hex: Option<&str>,
) -> Result<[u8; 32], String> {
    if context.is_empty() {
        return Err("NIP-SKD: context must be non-empty".to_string());
    }
    let root_priv = hex::decode(root_priv_hex).map_err(|e| format!("NIP-SKD: bad root priv: {e}"))?;
    if root_priv.len() != 32 {
        return Err("NIP-SKD: root priv must be 32 bytes".to_string());
    }

    // IKM: self = root_priv; shared = raw ECDH x-coordinate (peer reconstructed even-y).
    let ikm: Vec<u8> = match peer_pub_hex {
        None => root_priv.clone(),
        Some(peer_hex) => {
            let sk = SecpSecretKey::from_slice(&root_priv)
                .map_err(|e| format!("NIP-SKD: bad root priv: {e}"))?;
            let peer_bytes =
                hex::decode(peer_hex).map_err(|e| format!("NIP-SKD: bad peer pub: {e}"))?;
            let xonly = XOnlyPublicKey::from_slice(&peer_bytes)
                .map_err(|e| format!("NIP-SKD: bad peer pub: {e}"))?;
            let peer_pk = SecpPublicKey::from_x_only_public_key(xonly, Parity::Even);
            // shared_secret_point → 64 bytes (x || y, big-endian); take the raw x-coordinate.
            let point = shared_secret_point(&peer_pk, &sk);
            point[..32].to_vec()
        }
    };

    // HKDF-SHA256, salt = "nip-skd-v1", info = context, L = 48.
    let hk = Hkdf::<Sha256>::new(Some(SKD_SALT), &ikm);
    let mut seed = [0u8; 48];
    hk.expand(context.as_bytes(), &mut seed)
        .map_err(|_| "NIP-SKD: HKDF expand failed".to_string())?;

    // Wide reduction: interpret the 48-byte seed as a big-endian integer, reduce mod n. The
    // 128-bit margin over 256 bits makes `mod n` unbiased by construction (spec §1).
    let n = BigUint::parse_bytes(SECP256K1_N_HEX, 16).unwrap();
    let reduced = BigUint::from_bytes_be(&seed) % &n;
    if reduced.bits() == 0 {
        return Err("NIP-SKD: derived scalar is zero (re-derive)".to_string());
    }
    let rb = reduced.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - rb.len()..].copy_from_slice(&rb);
    Ok(out)
}

/// Derive the sub-key as nostr `Keys`, for signing / nip44 / nip04 as the sub-key.
pub fn derive_subkey_keys(
    root_priv_hex: &str,
    context: &str,
    peer_pub_hex: Option<&str>,
) -> Result<Keys, String> {
    let scalar = derive_subkey_scalar(root_priv_hex, context, peer_pub_hex)?;
    let sk = SecretKey::from_hex(&hex::encode(scalar)).map_err(|e| format!("NIP-SKD: {e}"))?;
    Ok(Keys::new(sk))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub_pub_hex(scalar: &[u8; 32]) -> String {
        Keys::new(SecretKey::from_hex(&hex::encode(scalar)).unwrap())
            .public_key()
            .to_hex()
    }

    // §8 self derivation: NIP-CHAT owner pseudonym O.
    #[test]
    fn vector_self() {
        let s = derive_subkey_scalar(
            &"11".repeat(32),
            "nip-chat:v2:owner-pseudonym:abc-123",
            None,
        )
        .unwrap();
        assert_eq!(
            sub_pub_hex(&s),
            "1a899ab5f78459554ba2aad008af3459597fd7906066a306f17d22415e2c59ee"
        );
    }

    // §8 shared derivation: NIP-CHAT member pseudonym P (member root 2222, peer = owner O_pub).
    #[test]
    fn vector_shared() {
        let s = derive_subkey_scalar(
            &"22".repeat(32),
            "nip-chat:v2:member-pseudonym:abc-123",
            Some("1a899ab5f78459554ba2aad008af3459597fd7906066a306f17d22415e2c59ee"),
        )
        .unwrap();
        assert_eq!(
            sub_pub_hex(&s),
            "be1eee04aba10e55fcf58ba2bd65a9c1c02c8abad9f2d607e7a511fde33cf251"
        );
    }

    // §8 symmetry / owner-verification: owner re-derives the same P from (O_priv, R_member_pub).
    // ecdh_x(R_member_priv, O_pub) == ecdh_x(O_priv, R_member_pub).
    #[test]
    fn vector_symmetry() {
        // Owner pseudonym private scalar (self-derived from owner root 1111).
        let o_priv = derive_subkey_scalar(
            &"11".repeat(32),
            "nip-chat:v2:owner-pseudonym:abc-123",
            None,
        )
        .unwrap();
        // Member ROOT pubkey (pubkey of root 2222).
        let r_member_pub = Keys::new(SecretKey::from_hex(&"22".repeat(32)).unwrap())
            .public_key()
            .to_hex();
        assert_eq!(
            r_member_pub,
            "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"
        );
        // Owner derives shared with (O_priv, R_member_pub, member context) → identical P.
        let p = derive_subkey_scalar(
            &hex::encode(o_priv),
            "nip-chat:v2:member-pseudonym:abc-123",
            Some(&r_member_pub),
        )
        .unwrap();
        assert_eq!(
            sub_pub_hex(&p),
            "be1eee04aba10e55fcf58ba2bd65a9c1c02c8abad9f2d607e7a511fde33cf251"
        );
    }

    #[test]
    fn empty_context_rejected() {
        assert!(derive_subkey_scalar(&"11".repeat(32), "", None).is_err());
    }
}
