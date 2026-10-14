//! HKDF-SHA256 with an arbitrary output length (ring only ships fixed key types).

use ring::hkdf;

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

/// `HKDF-SHA256(salt, ikm, info = concat(info), L = out.len())` (RFC 5869),
/// written into `out`. Every caller asks for a constant ≤ 96 bytes, far below
/// HKDF's 255 × 32 limit, so the expansion cannot fail.
pub(crate) fn hkdf_sha256(salt: &[u8], ikm: &[u8], info: &[&[u8]], out: &mut [u8]) {
    hkdf::Salt::new(hkdf::HKDF_SHA256, salt)
        .extract(ikm)
        .expand(info, Len(out.len()))
        .and_then(|okm| okm.fill(out))
        .expect("HKDF output length is a small constant");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 5869 Appendix A.1, test case 1.
    #[test]
    fn matches_rfc_5869_test_case_1() {
        let ikm = [0x0b; 22];
        let salt: Vec<u8> = (0x00..=0x0c).collect();
        let info: Vec<u8> = (0xf0..=0xf9).collect();
        let mut okm = [0u8; 42];
        hkdf_sha256(&salt, &ikm, &[&info[..5], &info[5..]], &mut okm);
        assert_eq!(
            crate::b64::encode(&okm),
            crate::b64::encode(&hex(
                "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
            ))
        );
    }

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
}
