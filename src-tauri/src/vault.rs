//! At-rest encryption for account secrets (private keys, seed words).
//!
//! A secret is stored as a **`denc1:`-prefixed envelope** instead of raw hex. The envelope is
//! AES-256-GCM ciphertext under a **key-encryption key (KEK)** that is itself derived from the
//! account's PIN/passphrase via **Argon2id** (a per-account salt, derived once at unlock, held in
//! memory only while unlocked). The secret's storage slot is bound in as GCM **associated data**
//! (AAD), so a blob cannot be lifted into a different account/field.
//!
//! Backwards compatibility: [`is_envelope`] distinguishes a `denc1:` value from a legacy raw-hex
//! secret, so reads transparently handle both and existing installs keep working until their
//! secrets are migrated (re-encrypted) at the next unlock.
//!
//! The KEK never leaves `zeroize`-wiped memory; the passphrase and derived bytes are wiped after
//! use. Nothing here touches the keyring — callers handle storage.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use rand::RngCore;
use zeroize::Zeroize;

/// Marks an encrypted value. Chosen so it can never collide with a legacy secret: those are
/// lowercase hex (`sk`) or space-separated BIP-39 words (`seed`), neither of which contains ':'.
pub const ENVELOPE_PREFIX: &str = "denc1:";

/// Envelope binary format version (after the prefix, before base64).
const FORMAT_V1: u8 = 1;
const NONCE_LEN: usize = 12;
const KEK_LEN: usize = 32;
const SALT_LEN: usize = 16;

/// Argon2id cost parameters, persisted per account so they can evolve. Defaults are deliberately
/// modest (64 MiB) because this runs once per unlock on a desktop and must stay snappy on low-end
/// machines; a stronger passphrase is the real security lever, not the cost.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub mem_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        KdfParams { mem_kib: 65536, iterations: 3, parallelism: 1 }
    }
}

/// A derived key-encryption key. Wiped on drop; never serialized or logged.
pub struct Kek([u8; KEK_LEN]);

impl Drop for Kek {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl Kek {
    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&self.0).expect("KEK is 32 bytes")
    }
}

/// A fresh random 16-byte Argon2id salt (base64, stored per account).
pub fn new_salt_b64() -> String {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(salt)
}

/// Derive the account KEK from its PIN/passphrase and stored salt. Expensive (Argon2id) — call once
/// per unlock, not per secret.
pub fn derive_kek(password: &str, salt_b64: &str, params: &KdfParams) -> Result<Kek, String> {
    let salt = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(salt_b64)
        .map_err(|e| format!("Bad KEK salt: {}", e))?;
    let argon_params = Params::new(params.mem_kib, params.iterations, params.parallelism, Some(KEK_LEN))
        .map_err(|e| format!("Bad Argon2 params: {}", e))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut key = [0u8; KEK_LEN];
    let mut pw = password.as_bytes().to_vec();
    let res = argon.hash_password_into(&pw, &salt, &mut key);
    pw.zeroize();
    res.map_err(|e| format!("Key derivation failed: {}", e))?;
    Ok(Kek(key))
}

/// True if `value` is an encrypted envelope (vs a legacy plaintext secret).
pub fn is_envelope(value: &str) -> bool {
    value.starts_with(ENVELOPE_PREFIX)
}

/// Generate a fresh random 256-bit key — the per-profile **data key (DEK)** that actually encrypts
/// secrets. It is itself stored wrapped under the PIN-derived KEK (see [`wrap_key`]), so a PIN change
/// only re-wraps this one key, never the secrets.
pub fn new_key() -> Kek {
    let mut k = [0u8; KEK_LEN];
    rand::thread_rng().fill_bytes(&mut k);
    Kek(k)
}

/// Encrypt raw `plaintext` bytes into a `denc1:` envelope, binding `aad` as associated data.
fn seal_bytes(key: &Kek, plaintext: &[u8], aad: &str) -> Result<String, String> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = key
        .cipher()
        .encrypt(nonce, Payload { msg: plaintext, aad: aad.as_bytes() })
        .map_err(|_| "Encryption failed".to_string())?;

    let mut buf = Vec::with_capacity(1 + NONCE_LEN + ct.len());
    buf.push(FORMAT_V1);
    buf.extend_from_slice(&nonce_bytes);
    buf.extend_from_slice(&ct);
    let out = format!("{}{}", ENVELOPE_PREFIX, base64::engine::general_purpose::STANDARD_NO_PAD.encode(&buf));
    buf.zeroize();
    Ok(out)
}

/// Decrypt a `denc1:` envelope to raw bytes. Errors on a wrong key, tampered blob, or mismatched AAD
/// (all surface as GCM authentication failure).
fn open_bytes(key: &Kek, envelope: &str, aad: &str) -> Result<Vec<u8>, String> {
    let b64 = envelope
        .strip_prefix(ENVELOPE_PREFIX)
        .ok_or_else(|| "Not a denc1 envelope".to_string())?;
    let buf = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(b64)
        .map_err(|e| format!("Bad envelope base64: {}", e))?;
    if buf.len() < 1 + NONCE_LEN + 16 || buf[0] != FORMAT_V1 {
        return Err("Unsupported or truncated envelope".to_string());
    }
    let nonce = Nonce::from_slice(&buf[1..1 + NONCE_LEN]);
    let ct = &buf[1 + NONCE_LEN..];
    key.cipher()
        .decrypt(nonce, Payload { msg: ct, aad: aad.as_bytes() })
        .map_err(|_| "Decryption failed (wrong PIN or tampered data)".to_string())
}

/// Encrypt a secret string into a `denc1:` envelope, binding `aad` (the storage slot).
pub fn seal(key: &Kek, plaintext: &str, aad: &str) -> Result<String, String> {
    seal_bytes(key, plaintext.as_bytes(), aad)
}

/// Decrypt a `denc1:` envelope produced by [`seal`] with the same `aad`.
pub fn open(key: &Kek, envelope: &str, aad: &str) -> Result<String, String> {
    let mut plain = open_bytes(key, envelope, aad)?;
    let out = String::from_utf8(plain.clone()).map_err(|_| "Decrypted data is not valid UTF-8".to_string())?;
    plain.zeroize();
    Ok(out)
}

/// Wrap the data key `dek` under the PIN-derived `kek`, binding `aad`. The result is stored and
/// doubles as the PIN verifier: a wrong PIN derives a wrong KEK and [`unwrap_key`] fails.
pub fn wrap_key(kek: &Kek, dek: &Kek, aad: &str) -> Result<String, String> {
    seal_bytes(kek, &dek.0, aad)
}

/// Unwrap a data key produced by [`wrap_key`]. A wrong `kek` (wrong PIN) fails with an auth error.
pub fn unwrap_key(kek: &Kek, wrapped: &str, aad: &str) -> Result<Kek, String> {
    let mut bytes = open_bytes(kek, wrapped, aad)?;
    if bytes.len() != KEK_LEN {
        bytes.zeroize();
        return Err("Unwrapped key has the wrong length".to_string());
    }
    let mut k = [0u8; KEK_LEN];
    k.copy_from_slice(&bytes);
    bytes.zeroize();
    Ok(Kek(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kek() -> Kek {
        let salt = new_salt_b64();
        // Tiny params so the test stays fast.
        derive_kek("12345678", &salt, &KdfParams { mem_kib: 8, iterations: 1, parallelism: 1 }).unwrap()
    }

    #[test]
    fn roundtrip() {
        let k = kek();
        let secret = "deadbeef".repeat(8); // 64-hex-ish
        let env = seal(&k, &secret, "p-abc/sk-pub1").unwrap();
        assert!(is_envelope(&env));
        assert_eq!(open(&k, &env, "p-abc/sk-pub1").unwrap(), secret);
    }

    #[test]
    fn wrong_aad_fails() {
        let k = kek();
        let env = seal(&k, "secret", "p-abc/sk-pub1").unwrap();
        assert!(open(&k, &env, "p-abc/sk-pub2").is_err()); // bound to its slot
    }

    #[test]
    fn wrong_key_fails() {
        let env = seal(&kek(), "secret", "slot").unwrap();
        assert!(open(&kek(), &env, "slot").is_err()); // different salt => different KEK
    }

    #[test]
    fn wrap_unwrap_roundtrip() {
        let kek = kek();
        let dek = new_key();
        let wrapped = wrap_key(&kek, &dek, "p-abc/dek").unwrap();
        let unwrapped = unwrap_key(&kek, &wrapped, "p-abc/dek").unwrap();
        // A secret sealed under the original DEK opens under the unwrapped one (same bytes).
        let env = seal(&dek, "sk-hex", "slot").unwrap();
        assert_eq!(open(&unwrapped, &env, "slot").unwrap(), "sk-hex");
        // A different KEK (wrong PIN) cannot unwrap.
        assert!(unwrap_key(&kek_other(), &wrapped, "p-abc/dek").is_err());
    }

    fn kek_other() -> Kek {
        derive_kek("99999999", &new_salt_b64(), &KdfParams { mem_kib: 8, iterations: 1, parallelism: 1 }).unwrap()
    }

    #[test]
    fn legacy_plaintext_not_envelope() {
        assert!(!is_envelope(&"a1b2c3".repeat(10))); // raw hex sk
        assert!(!is_envelope("word word word word word word word word word word word word"));
    }
}
