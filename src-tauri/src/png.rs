// PNG text chunks: reading Stable Diffusion generation parameters, and carrying text
// chunks over when the renderer re-encodes a PNG.

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::sync::LazyLock;

const SIG: &[u8] = b"\x89PNG\r\n\x1a\n";

// (type, start, end) of every chunk, stopping at IEND or a truncated chunk
fn chunks(buf: &[u8]) -> Vec<(&[u8], usize, usize)> {
    let mut out = Vec::new();
    if !buf.starts_with(SIG) {
        return out;
    }
    let mut pos = SIG.len();
    while pos + 12 <= buf.len() {
        let len = u32::from_be_bytes(buf[pos..pos + 4].try_into().unwrap()) as usize;
        let ty = &buf[pos + 4..pos + 8];
        let end = pos + 12 + len;
        if end > buf.len() {
            break;
        }
        out.push((ty, pos, end));
        if ty == b"IEND" {
            break;
        }
        pos = end;
    }
    out
}

// Canvas re-encoding drops PNG text chunks, which is where Stable Diffusion keeps its
// generation parameters. Copy the source's tEXt/iTXt/zTXt chunks into the new PNG,
// right after IHDR (chunks carry their own CRC, so they can be copied verbatim).
pub fn copy_text_chunks(src: &[u8], out: Vec<u8>) -> Vec<u8> {
    if !out.starts_with(SIG) || out.len() < SIG.len() + 12 {
        return out;
    }
    let text: Vec<&[u8]> = chunks(src)
        .into_iter()
        .filter(|(ty, _, _)| matches!(*ty, b"tEXt" | b"iTXt" | b"zTXt"))
        .map(|(_, s, e)| &src[s..e])
        .collect();
    if text.is_empty() {
        return out;
    }
    let ihdr_end = SIG.len() + 12 + u32::from_be_bytes(out[8..12].try_into().unwrap()) as usize;
    let mut merged = Vec::with_capacity(out.len() + text.iter().map(|c| c.len()).sum::<usize>());
    merged.extend_from_slice(&out[..ihdr_end]);
    for c in text {
        merged.extend_from_slice(c);
    }
    merged.extend_from_slice(&out[ihdr_end..]);
    merged
}

// The tEXt "parameters" value, decoded as Latin-1 like the PNG spec says
pub fn sd_parameters(buf: &[u8]) -> Option<String> {
    for (ty, s, e) in chunks(buf) {
        if ty == b"tEXt" {
            let data = &buf[s + 8..e - 4];
            if let Some(nul) = data.iter().position(|&b| b == 0) {
                if &data[..nul] == b"parameters" {
                    return Some(data[nul + 1..].iter().map(|&b| b as char).collect());
                }
            }
        }
    }
    None
}

#[derive(Serialize)]
pub struct SdParams {
    positive: String,
    negative: Option<String>,
    params: Map<String, Value>,
}

static PARAMS_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^(.*?)\n(Steps:.+)$").unwrap());
static PARAM_PAIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Za-z][A-Za-z0-9_ ]*?):\s*([^,\n]+)").unwrap());

// A1111 format: prompt, optional "Negative prompt:" block, then a "Steps: …" line of
// comma-separated key: value pairs
pub fn parse_sd(raw: &str) -> SdParams {
    const NEG: &str = "\nNegative prompt:";
    let (positive, negative, param_str) = match raw.find(NEG) {
        Some(i) => {
            let rest = &raw[i + NEG.len()..];
            match PARAMS_TAIL.captures(rest) {
                Some(m) => (raw[..i].trim().to_string(), Some(m[1].trim().to_string()), m[2].trim().to_string()),
                None => (raw[..i].trim().to_string(), Some(rest.trim().to_string()), String::new()),
            }
        }
        None => match PARAMS_TAIL.captures(raw) {
            Some(m) => (m[1].trim().to_string(), None, m[2].trim().to_string()),
            None => (raw.trim().to_string(), None, String::new()),
        },
    };
    let mut params = Map::new();
    for m in PARAM_PAIR.captures_iter(&param_str) {
        params.insert(m[1].trim().to_string(), Value::String(m[2].trim().to_string()));
    }
    SdParams { positive, negative, params }
}
