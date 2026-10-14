//! Web Push payload encryption, RFC 8291 (`aes128gcm`, RFC 8188), so a node
//! seals each notification for the phone's browser itself (contract §8). The
//! relay then only adds VAPID and POSTs the body: it never holds the
//! subscription's `p256dh` / `auth`, so it can neither read nor forge a push.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_128_GCM};
use ring::agreement::{agree_ephemeral, EphemeralPrivateKey, UnparsedPublicKey, ECDH_P256};
use ring::rand::SecureRandom;

use crate::kdf::hkdf_sha256;
use crate::Error;

/// Record size written in the header. One record carries the whole payload.
pub const RECORD_SIZE: u32 = 4096;

/// Header: salt (16) ‖ rs (4) ‖ idlen (1) ‖ keyid = server public key (65).
const HEADER_LEN: usize = 16 + 4 + 1 + 65;
const TAG_LEN: usize = 16;

/// Largest plaintext: push services cap the whole body at 4096 bytes, header,
/// tag and the 0x02 last-record delimiter included.
pub const MAX_PAYLOAD: usize = 4096 - HEADER_LEN - TAG_LEN - 1;

/// Encrypts `plaintext` for the subscription whose keys are `ua_public`
/// (`keys.p256dh`, 65 bytes uncompressed P-256) and `auth_secret`
/// (`keys.auth`, 16 bytes). Returns the request body to POST with
/// `Content-Encoding: aes128gcm`.
pub fn encrypt(
    ua_public: &[u8],
    auth_secret: &[u8],
    plaintext: &[u8],
    rng: &dyn SecureRandom,
) -> Result<Vec<u8>, Error> {
    let as_private = EphemeralPrivateKey::generate(&ECDH_P256, rng)?;
    let mut salt = [0u8; 16];
    rng.fill(&mut salt)?;
    encrypt_with(ua_public, auth_secret, plaintext, as_private, salt)
}

fn encrypt_with(
    ua_public: &[u8],
    auth_secret: &[u8],
    plaintext: &[u8],
    as_private: EphemeralPrivateKey,
    salt: [u8; 16],
) -> Result<Vec<u8>, Error> {
    if ua_public.len() != 65 || ua_public[0] != 0x04 {
        return Err(Error::Malformed("subscription p256dh"));
    }
    if auth_secret.len() != 16 {
        return Err(Error::Malformed("subscription auth"));
    }
    if plaintext.len() > MAX_PAYLOAD {
        return Err(Error::TooLarge { len: plaintext.len(), max: MAX_PAYLOAD });
    }
    let as_public = as_private.compute_public_key()?;
    let as_public = as_public.as_ref();
    let ecdh =
        agree_ephemeral(as_private, &UnparsedPublicKey::new(&ECDH_P256, ua_public), |s| s.to_vec())?;

    // RFC 8291 §3.4: IKM = HKDF(auth, ecdh, "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public, 32).
    let mut ikm = [0u8; 32];
    hkdf_sha256(auth_secret, &ecdh, &[b"WebPush: info\0", ua_public, as_public], &mut ikm);
    // RFC 8188 §2.2–2.3: content-encryption key and nonce from the salt.
    let mut cek = [0u8; 16];
    hkdf_sha256(&salt, &ikm, &[b"Content-Encoding: aes128gcm\0"], &mut cek);
    let mut nonce = [0u8; 12];
    hkdf_sha256(&salt, &ikm, &[b"Content-Encoding: nonce\0"], &mut nonce);

    let mut body = Vec::with_capacity(HEADER_LEN + plaintext.len() + 1 + TAG_LEN);
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);

    let mut record = Vec::with_capacity(plaintext.len() + 1 + TAG_LEN);
    record.extend_from_slice(plaintext);
    record.push(0x02); // last record, no padding
    let key = LessSafeKey::new(UnboundKey::new(&AES_128_GCM, &cek)?);
    key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut record)?;
    body.extend_from_slice(&record);
    Ok(body)
}

#[cfg(test)]
mod tests {
    #![allow(deprecated)] // ring's fixed-output RNG: the only way to replay a known answer

    use super::*;
    use crate::b64;
    use ring::test::rand::FixedSliceRandom;

    /// RFC 8291 Appendix A, byte for byte.
    #[test]
    fn matches_rfc_8291_appendix_a() {
        let plaintext = b"When I grow up, I want to be a watermelon";
        let as_seed = b64::decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "x").unwrap();
        let ua_public = b64::decode(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "x",
        )
        .unwrap();
        let auth = b64::decode("BTBZMqHH6r4Tts7J_aSIgg", "x").unwrap();
        let salt = b64::decode_exact::<16>("DGv6ra1nlYgDCS1FRnbzlw", "x").unwrap();

        let as_private =
            EphemeralPrivateKey::generate(&ECDH_P256, &FixedSliceRandom { bytes: &as_seed }).unwrap();
        assert_eq!(
            b64::encode(as_private.compute_public_key().unwrap().as_ref()),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        let body = encrypt_with(&ua_public, &auth, plaintext, as_private, salt).unwrap();
        assert_eq!(
            b64::encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn bad_subscription_keys_and_oversized_payloads_are_refused() {
        let rng = ring::rand::SystemRandom::new();
        let ua = [0x04u8; 65];
        assert_eq!(
            encrypt(&ua[..64], &[0; 16], b"x", &rng),
            Err(Error::Malformed("subscription p256dh"))
        );
        assert_eq!(encrypt(&ua, &[0; 15], b"x", &rng), Err(Error::Malformed("subscription auth")));
        let big = vec![0u8; MAX_PAYLOAD + 1];
        assert!(matches!(encrypt(&ua, &[0; 16], &big, &rng), Err(Error::TooLarge { .. })));
    }

    #[test]
    fn the_largest_payload_fits_the_push_services_4096_byte_cap() {
        assert_eq!(HEADER_LEN + MAX_PAYLOAD + 1 + TAG_LEN, 4096);
    }
}
