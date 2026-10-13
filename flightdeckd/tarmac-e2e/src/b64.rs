//! base64url without padding: the only binary-to-text encoding on the wire.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use crate::Error;

/// Encodes `bytes` as unpadded base64url.
pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decodes unpadded base64url. Padding, whitespace and the standard alphabet
/// are refused: there is exactly one valid spelling of each value.
pub fn decode(text: &str, what: &'static str) -> Result<Vec<u8>, Error> {
    URL_SAFE_NO_PAD.decode(text).map_err(|_| Error::Malformed(what))
}

/// Decodes unpadded base64url that must be exactly `N` bytes long.
pub fn decode_exact<const N: usize>(text: &str, what: &'static str) -> Result<[u8; N], Error> {
    decode(text, what)?.try_into().map_err(|_| Error::Malformed(what))
}

/// Length of the unpadded base64url encoding of `len` bytes.
pub const fn encoded_len(len: usize) -> usize {
    (len * 4).div_ceil(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_is_url_safe_unpadded() {
        let bytes = [0xfb, 0xff, 0xfe, 0x00, 0x01];
        let text = encode(&bytes);
        assert_eq!(text, "-__-AAE");
        assert_eq!(decode(&text, "x").unwrap(), bytes);
        assert_eq!(text.len(), encoded_len(bytes.len()));
    }

    #[test]
    fn padding_and_standard_alphabet_are_refused() {
        assert_eq!(decode("AA==", "x"), Err(Error::Malformed("x")));
        assert_eq!(decode("+/8", "x"), Err(Error::Malformed("x")));
        assert_eq!(decode("AA A", "x"), Err(Error::Malformed("x")));
    }

    #[test]
    fn exact_length_is_enforced() {
        assert!(decode_exact::<2>("AAE", "x").is_ok());
        assert_eq!(decode_exact::<3>("AAE", "x"), Err(Error::Malformed("x")));
    }
}
