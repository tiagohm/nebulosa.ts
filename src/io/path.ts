import type { PathLike } from 'fs'
import { stat } from 'fs/promises'

// Filesystem path checks for names and directories that arrive from outside the process, such as a file
// name in a capture request. The name check is pure and platform-independent on purpose: a request may be
// written on one operating system and executed on another, so a name is accepted only when it is a single
// portable file name everywhere. The directory probe touches the filesystem once and never throws.

// Longest file name, in UTF-8 bytes, that the common filesystems (ext4, APFS, NTFS, exFAT) accept.
const MAXIMUM_SEGMENT_BYTE_LENGTH = 255

// Characters Windows refuses in a file name. `:` also selects an NTFS alternate data stream, so a name
// carrying it would write into a hidden stream of another file rather than into a file of its own.
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/

// C0 control characters and DEL. NUL truncates the name on some platforms and the rest are refused by
// Windows or make a name that cannot be typed back.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

// Windows device names, reserved with any extension and in any letter case: `nul.fit` opens the null
// device instead of creating a file. The superscript digits are reserved alongside the plain ones.
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?$/i

// Reports whether a value can be used as exactly one portable path segment, a file or directory name.
//
// Rejects the empty name, `.` and `..`, both separators `/` and `\`, control characters, the characters
// Windows forbids, a trailing space or dot (Windows strips them, so the name would alias another file),
// Windows reserved device names with or without an extension, and names longer than 255 UTF-8 bytes. `..`
// is the one that escapes the directory a caller named; the others address a file the caller did not name
// or one that cannot be created on every platform. Names are not normalized, so a valid name is used as is.
export function isPathSegment(value: string) {
	if (value.length === 0 || value === '.' || value === '..') return false
	if (value.includes('/') || value.includes('\\')) return false
	if (CONTROL_CHARACTERS.test(value) || WINDOWS_FORBIDDEN_CHARACTERS.test(value)) return false

	const last = value.charCodeAt(value.length - 1)
	// 32 is the space and 46 the dot.
	if (last === 32 || last === 46) return false

	if (WINDOWS_RESERVED_NAME.test(value)) return false

	return Buffer.byteLength(value, 'utf-8') <= MAXIMUM_SEGMENT_BYTE_LENGTH
}

// Resolves whether `path` names an existing directory. A relative path resolves against the working
// directory of the process. A missing path, a regular file, or a path that cannot be inspected resolves
// false; it never rejects. Symbolic links are followed. Only the entry itself is inspected, so probing a
// large directory does not list its contents.
export async function directoryExists(path: PathLike): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}
