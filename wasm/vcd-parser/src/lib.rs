use serde_json::{json, Value as Json};
use std::collections::BTreeMap;
use std::io::Read;
use vcd::{Command, IdCode, Parser, VarType};

const MAX_INPUT: usize = 8 * 1024 * 1024;
const MAX_OUTPUT: usize = 32 * 1024 * 1024;
const MAX_TIME: u64 = 9_007_199_254_740_991;

struct Timeline {
    width: usize,
    kind: &'static str,
    changes: Vec<(u64, String)>,
}

fn append(
    timelines: &mut [Timeline],
    codes: &BTreeMap<IdCode, usize>,
    code: IdCode,
    time: u64,
    kind: &str,
    mut value: String,
    budget: &mut usize,
) -> Result<(), String> {
    let index = *codes.get(&code).ok_or("VCD contains an undeclared signal.")?;
    let timeline = &mut timelines[index];
    if timeline.kind != kind {
        return Err("VCD value type does not match its declaration.".into());
    }
    if kind == "logic" {
        if value.len() > timeline.width {
            return Err("VCD value is wider than its declared signal.".into());
        }
        let fill = match value.as_bytes().first() {
            Some(b'x') => 'x',
            Some(b'z') => 'z',
            _ => '0',
        };
        value = fill.to_string().repeat(timeline.width - value.len()) + &value;
    }
    *budget += value.len() + 32;
    if *budget > MAX_OUTPUT {
        return Err("VCD exceeds the 32 MiB expanded preview limit. Use the WDB viewer.".into());
    }
    if let Some(previous) = timeline.changes.last_mut() {
        if previous.0 == time {
            previous.1 = value;
            return Ok(());
        }
        if previous.1 == value {
            return Ok(());
        }
    }
    timeline.changes.push((time, value));
    Ok(())
}

pub fn parse_waveform(input: &[u8]) -> Result<Json, String> {
    if input.len() > MAX_INPUT {
        return Err("VCD exceeds the 8 MiB preview limit.".into());
    }
    std::str::from_utf8(input).map_err(|_| "VCD is not valid UTF-8.")?;
    // The upstream tokenizer needs whitespace to terminate the final token.
    // Appending only whitespace preserves both the last value and end time.
    let mut parser = Parser::new(input.chain(&b"\n"[..]));
    let mut scopes = Vec::new();
    let mut signals = Vec::new();
    let mut timelines: Vec<Timeline> = Vec::new();
    let mut codes = BTreeMap::new();
    let mut timescale = None;
    let mut definitions = false;

    // Consume upstream parser commands incrementally, bounding header depth before
    // allocating a recursive scope tree. No VCD tokenization is implemented here.
    for command in parser.by_ref() {
        match command.map_err(|error| format!("Cannot parse VCD header: {error}"))? {
            Command::Date(_) | Command::Version(_) | Command::Comment(_) => {}
            Command::Timescale(value, unit) if value > 0 => {
                timescale = Some((value, unit.to_string()));
            }
            Command::ScopeDef(_, name) => {
                if scopes.len() >= 64 {
                    return Err("VCD hierarchy is too deep for preview.".into());
                }
                scopes.push(name);
            }
            Command::Upscope => {
                scopes.pop().ok_or("VCD has an unmatched upscope.")?;
            }
            Command::VarDef(var_type, width, code, reference, index) => {
                if signals.len() >= 2048 {
                    return Err("VCD exceeds 2048 signals. Use the WDB viewer.".into());
                }
                if width == 0 || width > 4096 {
                    return Err("VCD bus is too wide or has zero width.".into());
                }
                let kind = match var_type {
                    VarType::Real => "real",
                    VarType::String => "string",
                    _ => "logic",
                };
                let next_index = timelines.len();
                let timeline = *codes.entry(code).or_insert(next_index);
                if timeline == next_index {
                    timelines.push(Timeline {
                        width: width as usize,
                        kind,
                        changes: Vec::new(),
                    });
                } else if timelines[timeline].width != width as usize
                    || timelines[timeline].kind != kind
                {
                    return Err("VCD aliases have incompatible declarations.".into());
                }
                let mut names = scopes.clone();
                let mut name = reference;
                if let Some(vcd::ReferenceIndex::BitSelect(bit)) = index {
                    name.push_str(&format!("[{bit}]"));
                }
                names.push(name);
                signals.push(json!({
                    "name": names.join("."), "width": width, "type": kind, "timeline": timeline
                }));
            }
            Command::Enddefinitions => {
                if !scopes.is_empty() {
                    return Err("VCD has unclosed scopes.".into());
                }
                definitions = true;
                break;
            }
            _ => return Err("VCD has an invalid or incomplete header.".into()),
        }
    }
    let (timescale, unit) = timescale.ok_or("VCD is missing its timescale.")?;
    if !definitions || signals.is_empty() {
        return Err("VCD is missing its signal definitions.".into());
    }
    let mut time = 0;
    let mut changes = 0;
    let mut budget = 0;
    for command in parser {
        let command = command.map_err(|error| format!("Cannot parse VCD values: {error}"))?;
        let (code, kind, value) = match command {
            Command::Timestamp(next) => {
                if next < time || next > MAX_TIME {
                    return Err("VCD timestamps cannot be represented accurately in this preview.".into());
                }
                time = next;
                continue;
            }
            Command::Comment(_) | Command::Begin(_) | Command::End(_) => continue,
            Command::ChangeScalar(code, value) => (code, "logic", value.to_string()),
            Command::ChangeVector(code, value) => (code, "logic", value.to_string()),
            Command::ChangeReal(code, value) => {
                if !value.is_finite() {
                    return Err("VCD has a non-finite real value.".into());
                }
                (code, "real", value.to_string())
            }
            Command::ChangeString(code, value) => (code, "string", value),
            _ => return Err("VCD contains a header command after its definitions.".into()),
        };
        changes += 1;
        if changes > 500_000 {
            return Err("VCD exceeds 500000 changes. Use the WDB viewer.".into());
        }
        append(&mut timelines, &codes, code, time, kind, value, &mut budget)?;
    }
    // Serialize each timeline once. The host shares it between aliases.
    let timelines: Vec<_> = timelines.into_iter().map(|timeline| timeline.changes).collect();
    Ok(json!({
        "timescale": timescale, "unit": unit, "endTime": time,
        "signals": signals, "timelines": timelines
    }))
}

#[no_mangle]
pub extern "C" fn vcd_abi_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn vcd_alloc(length: usize) -> *mut u8 {
    if length == 0 || length > MAX_INPUT {
        return std::ptr::null_mut();
    }
    Box::into_raw(vec![0u8; length].into_boxed_slice()) as *mut u8
}

/// # Safety
/// `pointer` and `length` must describe an allocation returned by this module.
#[no_mangle]
pub unsafe extern "C" fn vcd_free(pointer: *mut u8, length: usize) {
    if !pointer.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length)));
    }
}

/// # Safety
/// The input must be a live `vcd_alloc` allocation of the supplied length.
/// The result is an owned buffer: u32 little-endian length followed by JSON.
#[no_mangle]
pub unsafe extern "C" fn vcd_parse(pointer: *const u8, length: usize) -> *mut u8 {
    let result = if pointer.is_null() || length == 0 || length > MAX_INPUT {
        Err("VCD input is empty or exceeds the 8 MiB preview limit.".into())
    } else {
        parse_waveform(std::slice::from_raw_parts(pointer, length))
    };
    let value = match result {
        Ok(data) => json!({ "data": data }),
        Err(error) => json!({ "error": error }),
    };
    let bytes = serde_json::to_vec(&value).expect("JSON contains only finite numbers");
    let mut output = Vec::with_capacity(bytes.len() + 4);
    output.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(&bytes);
    Box::into_raw(output.into_boxed_slice()) as *mut u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_changes_without_a_trailing_timestamp() {
        let data = parse_waveform(b"$timescale 1 ns $end\n$var wire 1 ! clk $end\n$enddefinitions $end\n#0\n0!\n#5\n1!").unwrap();
        assert_eq!(data["endTime"], 5);
        assert_eq!(data["timelines"][0], json!([[0, "0"], [5, "1"]]));
    }

    #[test]
    fn rejects_time_reversal_and_missing_timescale() {
        assert!(parse_waveform(b"$enddefinitions $end").is_err());
        let bad = b"$timescale 1 ns $end\n$var wire 1 ! clk $end\n$enddefinitions $end\n#5\n0!\n#1\n1!";
        assert!(parse_waveform(bad).unwrap_err().contains("timestamps"));
    }
}
