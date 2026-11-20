//! Transaction-scope validity policy for Turnup's chains: the root and each
//! area chain. It is Stoa's ownership policy (stoasocial/stoa, policy/) with
//! one record added, `migrated-from`.
//!
//! Base consensus lets any signer write any general-state key. This policy
//! attributes every key to its writer, in one of two shapes:
//!
//! - `user/<owner>/...`: the owner's own records.
//! - `index/.../<owner>`: the owner's entry under a shared topic, so a topic
//!   can be listed by prefix without knowing who wrote to it.
//!
//! The owner segment must be one of the transaction's signers. Whoever owns a
//! key may create, overwrite or delete it. What the records mean is up to
//! clients; the chain only says whose they are.
//!
//! A post or comment (`user/<owner>/post/<id>`) states when it was written:
//! its JSON has one top-level `"time"`, a whole number of milliseconds, no
//! later than the block's timestamp and at most `TIME_WINDOW_BLOCKS` of the
//! chain's target block times (its spec's `targetBlockTime`) before it.
//! A change keeps the time it was created with; a deletion is free. A JSON
//! key holding an escape is refused, so this policy and a reader's JSON
//! parser cannot disagree on which key is `"time"`.
//!
//! `migrated-from` says which chain this one carries on from: the chain, the
//! block it was copied at, and the snapshot. Its value is fixed when the
//! module is built (`policy/migrated-from`, so the chain's spec commits to
//! it through the module's CID). Anyone may write that exact value once;
//! nobody may write anything else there, change it or delete it. A module
//! built with no value refuses the key.
//!
//! Coin actions (transfers, deposits, receipts, withdrawals) are not this
//! policy's business and pass untouched.
#![cfg_attr(not(test), no_std)]

const MAGIC: &[u8] = b"LWPCTX";
const CONTEXT_ENCODING_VERSION: u16 = 2;
/// Magic, encoding version, ABI version, scope, height, timestamp.
const HEADER_BYTES: usize = 6 + 2 + 2 + 1 + 8 + 8;
/// Where the block's timestamp (int64 ms, big-endian) sits in the header.
const TIMESTAMP_AT: usize = 19;
/// How long before its block a post may say it was written, in the chain's
/// target block times.
pub const TIME_WINDOW_BLOCKS: u64 = 60;

const MIGRATED_FROM_KEY: &[u8] = b"migrated-from";
/// The only value `migrated-from` may hold, with any trailing whitespace the
/// file ends in left off; empty when this chain carries on from none.
const MIGRATED_FROM: &[u8] = trim_end(include_bytes!("../migrated-from"));

const fn trim_end(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 && matches!(bytes[end - 1], b' ' | b'\t' | b'\n' | b'\r') {
        end -= 1;
    }
    bytes.split_at(end).0
}

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    let Some(raw) = context.get(TIMESTAMP_AT..HEADER_BYTES) else {
        return false;
    };
    let timestamp = i64::from_be_bytes(raw.try_into().unwrap_or([0; 8]));
    transaction(context)
        .and_then(|(spec, body)| {
            let window = i64::try_from(target_block_time(spec)?.checked_mul(TIME_WINDOW_BLOCKS)?).ok()?;
            check_body(body, timestamp, window)
        })
        .is_some()
}

/// The chain spec's `targetBlockTime` (milliseconds).
fn target_block_time(spec: &[u8]) -> Option<u64> {
    let (major, value, _) = head(spec, map_value(spec, 0, b"targetBlockTime")?)?;
    (major == UNSIGNED).then_some(value)
}

/// The chain spec and the transaction body.
fn transaction(context: &[u8]) -> Option<(&[u8], &[u8])> {
    if context.get(..MAGIC.len())? != MAGIC {
        return None;
    }
    if u16::from_be_bytes(context.get(6..8)?.try_into().ok()?) != CONTEXT_ENCODING_VERSION {
        return None;
    }
    let mut at = HEADER_BYTES;
    let (spec, next) = length_prefixed(context, at)?;
    at = next;
    let path_items = u32_at(context, at)?;
    at += 4;
    for _ in 0..path_items {
        at = length_prefixed(context, at)?.1;
    }
    if *context.get(at)? != 1 {
        return None;
    }
    Some((spec, length_prefixed(context, at + 1)?.0))
}

fn check_body(body: &[u8], timestamp: i64, window: i64) -> Option<()> {
    if skip(body, 0)? != body.len() {
        return None;
    }
    let signers = map_value(body, 0, b"signers")?;
    let actions = map_value(body, 0, b"actions")?;
    let (major, count, mut at) = head(body, actions)?;
    if major != ARRAY {
        return None;
    }
    for _ in 0..count {
        let key = text(body, map_value(body, at, b"key")?)?;
        let value = |name: &[u8]| match map_value(body, at, name) {
            Some(offset) => text(body, offset).map(Some),
            None => Some(None),
        };
        if key == MIGRATED_FROM_KEY {
            check_migrated_from(value(b"oldValue")?, value(b"newValue")?)?;
            at = skip(body, at)?;
            continue;
        }
        check_key(body, signers, key)?;
        if is_post_key(key) {
            if key.ends_with(b"/") {
                return None; // a post with no id
            }
            check_time(value(b"oldValue")?, value(b"newValue")?, timestamp, window)?;
        }
        at = skip(body, at)?;
    }
    Some(())
}

/// Created, holding exactly the value built in; never changed or deleted.
fn check_migrated_from(old: Option<&[u8]>, new: Option<&[u8]>) -> Option<()> {
    (old.is_none() && !MIGRATED_FROM.is_empty() && new? == MIGRATED_FROM).then_some(())
}

fn check_key(body: &[u8], signers: usize, key: &[u8]) -> Option<()> {
    let mut segments = key.split(|&byte| byte == b'/');
    let owner = match segments.next()? {
        b"user" => segments.next()?,
        b"index" => {
            segments.next()?; // at least one topic segment
            segments.last()?
        }
        _ => return None,
    };
    is_signer(body, signers, owner)
}

/// `user/<owner>/post/<id>`: a post or comment itself (not its media). The
/// id may be empty here; `check_time` refuses that.
fn is_post_key(key: &[u8]) -> bool {
    let mut parts = key.split(|&byte| byte == b'/');
    parts.next() == Some(b"user")
        && parts.next().is_some()
        && parts.next() == Some(b"post")
        && parts.next().is_some()
        && parts.next().is_none()
}

/// Created: its time is in `[timestamp - window, timestamp]`. Changed: its
/// time is the one it was created with. Deleted: anything goes.
fn check_time(old: Option<&[u8]>, new: Option<&[u8]>, timestamp: i64, window: i64) -> Option<()> {
    match (old, new) {
        (None, Some(new)) => {
            let time = time_of(new)?;
            (time <= timestamp && timestamp.checked_sub(time)? <= window).then_some(())
        }
        (Some(old), Some(new)) => (time_of(old)? == time_of(new)?).then_some(()),
        _ => Some(()),
    }
}

fn is_signer(body: &[u8], signers: usize, owner: &[u8]) -> Option<()> {
    let (major, count, mut at) = head(body, signers)?;
    if major != ARRAY {
        return None;
    }
    for _ in 0..count {
        if text(body, at)? == owner {
            return Some(());
        }
        at = skip(body, at)?;
    }
    None
}

fn u32_at(bytes: &[u8], at: usize) -> Option<usize> {
    let raw = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_be_bytes(raw.try_into().ok()?) as usize)
}

fn length_prefixed(bytes: &[u8], at: usize) -> Option<(&[u8], usize)> {
    let start = at.checked_add(4)?;
    let end = start.checked_add(u32_at(bytes, at)?)?;
    Some((bytes.get(start..end)?, end))
}

// DAG-CBOR: definite lengths only, text-keyed maps.

const UNSIGNED: u8 = 0;
const BYTES: u8 = 2;
const TEXT: u8 = 3;
const ARRAY: u8 = 4;
const MAP: u8 = 5;
const TAG: u8 = 6;

/// The item head at `at`: `(major type, argument, offset after the head)`.
fn head(bytes: &[u8], at: usize) -> Option<(u8, u64, usize)> {
    let first = *bytes.get(at)?;
    let width = match first & 0x1f {
        small @ 0..=23 => return Some((first >> 5, small as u64, at + 1)),
        24 => 1,
        25 => 2,
        26 => 4,
        27 => 8,
        _ => return None,
    };
    let end = (at + 1).checked_add(width)?;
    let argument = bytes
        .get(at + 1..end)?
        .iter()
        .fold(0u64, |value, &byte| (value << 8) | byte as u64);
    Some((first >> 5, argument, end))
}

/// The offset just past the item at `at`.
fn skip(bytes: &[u8], mut at: usize) -> Option<usize> {
    let mut pending: u64 = 1;
    while pending > 0 {
        let (major, argument, next) = head(bytes, at)?;
        at = next;
        pending -= 1;
        match major {
            BYTES | TEXT => {
                at = at.checked_add(usize::try_from(argument).ok()?)?;
                if at > bytes.len() {
                    return None;
                }
            }
            ARRAY => pending = pending.checked_add(argument)?,
            MAP => pending = pending.checked_add(argument.checked_mul(2)?)?,
            TAG => pending += 1,
            _ => {}
        }
    }
    Some(at)
}

/// The offset of the value stored under `key` in the map at `at`.
fn map_value(bytes: &[u8], at: usize, key: &[u8]) -> Option<usize> {
    let (major, pairs, mut next) = head(bytes, at)?;
    if major != MAP {
        return None;
    }
    for _ in 0..pairs {
        let name = text(bytes, next)?;
        let value = skip(bytes, next)?;
        if name == key {
            return Some(value);
        }
        next = skip(bytes, value)?;
    }
    None
}

fn text(bytes: &[u8], at: usize) -> Option<&[u8]> {
    let (major, length, start) = head(bytes, at)?;
    if major != TEXT {
        return None;
    }
    bytes.get(start..start.checked_add(usize::try_from(length).ok()?)?)
}

// JSON: just enough to find a post's top-level `"time"`.

/// The top-level `"time"` of a JSON object: exactly one, a non-negative whole
/// number with no fraction or exponent. None for anything else, or for an
/// object with a key holding an escape.
pub fn time_of(json: &[u8]) -> Option<i64> {
    let mut j = Json { bytes: json, at: 0 };
    j.space();
    j.expect(b'{')?;
    let mut time = None;
    j.space();
    if j.peek() == Some(b'}') {
        j.at += 1;
    } else {
        loop {
            j.space();
            let key = j.string()?;
            if key.contains(&b'\\') {
                return None;
            }
            j.space();
            j.expect(b':')?;
            j.space();
            if key == b"time" {
                if time.is_some() {
                    return None;
                }
                time = Some(j.integer()?);
            } else {
                j.value(0)?;
            }
            j.space();
            match j.next()? {
                b',' => continue,
                b'}' => break,
                _ => return None,
            }
        }
    }
    j.space();
    if j.at != json.len() {
        return None;
    }
    time
}

struct Json<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Json<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }
    fn next(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.at += 1;
        Some(byte)
    }
    fn expect(&mut self, byte: u8) -> Option<()> {
        (self.next()? == byte).then_some(())
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }
    /// A string's raw contents, escapes left as written.
    fn string(&mut self) -> Option<&'a [u8]> {
        self.expect(b'"')?;
        let start = self.at;
        loop {
            match self.next()? {
                b'"' => return Some(&self.bytes[start..self.at - 1]),
                b'\\' => {
                    self.next()?;
                }
                byte if byte < 0x20 => return None,
                _ => {}
            }
        }
    }
    fn integer(&mut self) -> Option<i64> {
        let start = self.at;
        let mut value: i64 = 0;
        while let Some(digit @ b'0'..=b'9') = self.peek() {
            value = value.checked_mul(10)?.checked_add((digit - b'0') as i64)?;
            self.at += 1;
        }
        let digits = self.at - start;
        if digits == 0 || (digits > 1 && self.bytes[start] == b'0') {
            return None;
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return None;
        }
        Some(value)
    }
    /// Skips one value.
    fn value(&mut self, depth: u32) -> Option<()> {
        if depth > 64 {
            return None;
        }
        match self.peek()? {
            b'"' => self.string().map(|_| ()),
            b'{' | b'[' => {
                let close = if self.next()? == b'{' { b'}' } else { b']' };
                self.space();
                if self.peek() == Some(close) {
                    self.at += 1;
                    return Some(());
                }
                loop {
                    self.space();
                    if close == b'}' {
                        self.string()?;
                        self.space();
                        self.expect(b':')?;
                        self.space();
                    }
                    self.value(depth + 1)?;
                    self.space();
                    match self.next()? {
                        b',' => continue,
                        byte if byte == close => return Some(()),
                        _ => return None,
                    }
                }
            }
            b't' => self.word(b"true"),
            b'f' => self.word(b"false"),
            b'n' => self.word(b"null"),
            _ => {
                if self.peek() == Some(b'-') {
                    self.at += 1;
                }
                let start = self.at;
                while matches!(self.peek(), Some(b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')) {
                    self.at += 1;
                }
                (self.at > start).then_some(())
            }
        }
    }
    fn word(&mut self, word: &[u8]) -> Option<()> {
        let end = self.at.checked_add(word.len())?;
        (self.bytes.get(self.at..end)? == word).then(|| self.at = end)
    }
}

#[cfg(target_arch = "wasm32")]
mod abi {
    use core::arch::wasm32::{memory_grow, memory_size, unreachable};

    const PAGE_BYTES: usize = 65536;

    extern "C" {
        static __heap_base: u8;
    }

    /// The host calls this once per evaluation, on a fresh instance, so the
    /// allocation is simply the memory above the module's own data.
    #[no_mangle]
    pub extern "C" fn lattice_alloc(length: i32) -> i32 {
        let base = unsafe { &__heap_base as *const u8 as usize };
        let Some(end) = usize::try_from(length).ok().and_then(|length| base.checked_add(length))
        else {
            return -1;
        };
        let have = memory_size(0) * PAGE_BYTES;
        if end > have && memory_grow(0, (end - have).div_ceil(PAGE_BYTES)) == usize::MAX {
            return -1;
        }
        base as i32
    }

    #[no_mangle]
    pub extern "C" fn lattice_validate_transaction(pointer: i32, length: i32) -> i32 {
        if pointer < 0 || length < 0 {
            return 0;
        }
        let context =
            unsafe { core::slice::from_raw_parts(pointer as usize as *const u8, length as usize) };
        super::validate(context) as i32
    }

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo) -> ! {
        unreachable()
    }
}
