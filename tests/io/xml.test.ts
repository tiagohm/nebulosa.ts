import { describe, expect, test } from 'bun:test'
import { SimpleXmlParser, type XmlNode } from '../../src/io/xml'

const input = `
<person id="1" type="student">
    <name>
    John Doe
    </name>
    <age>25</age>
    <address city="New York"/>
</person>
`

const TEXT_DECODER = new TextDecoder()
const TEXT_ENCODER = new TextEncoder()
const EMPTY_TEXT = new Uint8Array(0)

function nodeText(node: XmlNode) {
	return TEXT_DECODER.decode(node.text).trim()
}

function encodeText(text: string) {
	return TEXT_ENCODER.encode(text)
}

describe('parse', () => {
	test('single', () => {
		const parser = new SimpleXmlParser()
		const [tag] = parser.parse(input)

		expect(tag).toBeDefined()
		expect(tag.name).toBe('person')
		expect(tag.attributes.id).toBe('1')
		expect(tag.attributes.type).toBe('student')
		expect(nodeText(tag)).toBeEmpty()
		expect(tag.children).toHaveLength(3)
		expect(tag.children[0].name).toBe('name')
		expect(nodeText(tag.children[0])).toBe('John Doe')
		expect(tag.children[0].children).toBeEmpty()
		expect(tag.children[1].name).toBe('age')
		expect(nodeText(tag.children[1])).toBe('25')
		expect(tag.children[1].children).toBeEmpty()
		expect(tag.children[2].name).toBe('address')
		expect(tag.children[2].attributes.city).toBe('New York')
		expect(nodeText(tag.children[2])).toBe('')
		expect(tag.children[2].children).toBeEmpty()
	})

	test('multiple', () => {
		const parser = new SimpleXmlParser()
		const tags = parser.parse(`${input}${input}${input}`)

		expect(tags).toHaveLength(3)

		for (let i = 0; i < 3; i++) {
			expect(tags[i].name).toBe('person')
			expect(tags[i].attributes.id).toBe('1')
			expect(tags[i].attributes.type).toBe('student')
			expect(nodeText(tags[i])).toBeEmpty()
			expect(tags[i].children).toHaveLength(3)
			expect(tags[i].children[0].name).toBe('name')
			expect(nodeText(tags[i].children[0])).toBe('John Doe')
			expect(tags[i].children[0].children).toBeEmpty()
			expect(tags[i].children[1].name).toBe('age')
			expect(nodeText(tags[i].children[1])).toBe('25')
			expect(tags[i].children[1].children).toBeEmpty()
			expect(tags[i].children[2].name).toBe('address')
			expect(tags[i].children[2].attributes.city).toBe('New York')
			expect(nodeText(tags[i].children[2])).toBe('')
			expect(tags[i].children[2].children).toBeEmpty()
		}
	})

	test('splitted', () => {
		const parser = new SimpleXmlParser()
		const lines = input.trim().split('\n')

		for (let i = 0; i < lines.length - 1; i++) {
			expect(parser.parse(lines[i])).toBeEmpty()
		}

		const [tag] = parser.parse(lines.at(-1)!)

		expect(tag).toBeDefined()
		expect(tag.name).toBe('person')
		expect(tag.attributes.id).toBe('1')
		expect(tag.attributes.type).toBe('student')
		expect(nodeText(tag)).toBeEmpty()
		expect(tag.children).toHaveLength(3)
		expect(tag.children[0].name).toBe('name')
		expect(nodeText(tag.children[0])).toBe('John Doe')
		expect(tag.children[0].children).toBeEmpty()
		expect(tag.children[1].name).toBe('age')
		expect(nodeText(tag.children[1])).toBe('25')
		expect(tag.children[1].children).toBeEmpty()
		expect(tag.children[2].name).toBe('address')
		expect(tag.children[2].attributes.city).toBe('New York')
		expect(nodeText(tag.children[2])).toBe('')
		expect(tag.children[2].children).toBeEmpty()
	})

	test('edge cases', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person></person>')).toEqual([{ name: 'person', attributes: {}, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person name="John"></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person name="John" disabled student></person>')).toEqual([{ name: 'person', attributes: { name: 'John', disabled: '', student: '' }, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person gender=""></person>')).toEqual([{ name: 'person', attributes: { gender: '' }, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person>Text</person>')).toEqual([{ name: 'person', attributes: {}, children: [], text: encodeText('Text') }])
		expect(parser.parse('<person name="John"><phone number="5511987654321"></phone></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [{ name: 'phone', attributes: { number: '5511987654321' }, children: [], text: EMPTY_TEXT }], text: EMPTY_TEXT }])
		expect(parser.parse('<person name="John"><phone number="5511987654321" /></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [{ name: 'phone', attributes: { number: '5511987654321' }, children: [], text: EMPTY_TEXT }], text: EMPTY_TEXT }])
		expect(parser.parse('<person name="John"><phone country="55">11987654321</phone></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [{ name: 'phone', attributes: { country: '55' }, children: [], text: encodeText('11987654321') }], text: EMPTY_TEXT }])
		expect(parser.parse('<person name="John"><phone number="5511987654321"></phone><phone country="55">11976543210</phone></person>')).toEqual([
			{
				name: 'person',
				attributes: { name: 'John' },
				children: [
					{ name: 'phone', attributes: { number: '5511987654321' }, children: [], text: EMPTY_TEXT },
					{ name: 'phone', attributes: { country: '55' }, children: [], text: encodeText('11976543210') },
				],
				text: EMPTY_TEXT,
			},
		])
		expect(parser.parse('<person name="John"><address><city>New York</city></address></person>')).toEqual([
			{ name: 'person', attributes: { name: 'John' }, children: [{ name: 'address', attributes: {}, children: [{ name: 'city', attributes: {}, children: [], text: encodeText('New York') }], text: EMPTY_TEXT }], text: EMPTY_TEXT },
		])
		expect(parser.parse('<person name="John"><address><city>New York</city><complement/></address></person>')).toEqual([
			{
				name: 'person',
				attributes: { name: 'John' },
				children: [
					{
						name: 'address',
						attributes: {},
						children: [
							{ name: 'city', attributes: {}, children: [], text: encodeText('New York') },
							{ name: 'complement', attributes: {}, children: [], text: EMPTY_TEXT },
						],
						text: EMPTY_TEXT,
					},
				],
				text: EMPTY_TEXT,
			},
		])

		expect(parser.parse('<person/>')).toEqual([{ name: 'person', attributes: {}, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person name="John"/>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person name="John" disabled student/>')).toEqual([{ name: 'person', attributes: { name: 'John', disabled: '', student: '' }, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person gender=""/>')).toEqual([{ name: 'person', attributes: { gender: '' }, children: [], text: EMPTY_TEXT }])
	})

	test('parses deeply nested tags', () => {
		const parser = new SimpleXmlParser()
		const [root] = parser.parse('<a><b><c><d><e>deep</e></d></c></b></a>')

		let node = root
		for (const name of ['a', 'b', 'c', 'd', 'e']) {
			expect(node.name).toBe(name)
			if (name !== 'e') {
				expect(node.children).toHaveLength(1)
				node = node.children[0]
			}
		}
		expect(nodeText(node)).toBe('deep')
		expect(node.children).toBeEmpty()
	})

	test('mixed content after child tags', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person>John<phone/>Doe</person>')).toEqual([{ name: 'person', attributes: {}, children: [{ name: 'phone', attributes: {}, children: [], text: EMPTY_TEXT }], text: encodeText('JohnDoe') }])
		expect(parser.parse('<person><phone></phone>Doe</person>')).toEqual([{ name: 'person', attributes: {}, children: [{ name: 'phone', attributes: {}, children: [], text: EMPTY_TEXT }], text: encodeText('Doe') }])
	})

	test('preserve valid name characters', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person-data attr_name="1" attr-name="2" xmlns:x="3"></person-data>')).toEqual([
			{
				name: 'person-data',
				attributes: { attr_name: '1', 'attr-name': '2', 'xmlns:x': '3' },
				children: [],
				text: EMPTY_TEXT,
			},
		])
	})

	test('treat tabs and newlines as tag whitespace', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person\tname="John"></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person\nname="John"></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [], text: EMPTY_TEXT }])
	})

	test('reject mismatched closing tags', () => {
		const parser = new SimpleXmlParser()

		expect(() => parser.parse('<person><name></person></name>')).toThrow('mismatched closing tag')
	})

	test('should parse char code > 128', () => {
		const parse = new SimpleXmlParser()
		const xml = `
        <defNumberVector device="WandererCover V4-EC" name="STATUS" label="Real Time Status" group="Main Control" state="Idle" perm="ro" timeout="60" timestamp="2026-03-23T01:39:04">
            <defNumber name="Closed_Position" label="Closed Position Set(°)" format="%4.2f" min="0" max="999" step="100">0</defNumber>
        </defNumberVector>
        `

		const node = parse.parse(xml)
		expect(node).toHaveLength(1)
		expect(node[0].name).toBe('defNumberVector')
		expect(node[0].attributes.device).toBe('WandererCover V4-EC')
		expect(node[0].children[0].attributes.label).toBe('Closed Position Set(°)')
	})

	test('should parse unicode char', () => {
		const parse = new SimpleXmlParser()
		const xml = `<person status="😎"></person>`

		const node = parse.parse(xml)
		expect(node).toHaveLength(1)
		expect(node[0].name).toBe('person')
		expect(node[0].attributes.status).toBe('😎')
	})
})

describe('behavior', () => {
	test('an opening tag with attributes is only emitted when it closes', () => {
		const parser = new SimpleXmlParser()

		// Regression guard: the opening tag must not complete a top-level node before its close.
		expect(parser.parse('<person id="1">')).toBeEmpty()
		expect(parser.parse('text</person>')).toEqual([{ name: 'person', attributes: { id: '1' }, children: [], text: encodeText('text') }])
	})

	test('trims surrounding whitespace and drops whitespace-only text', () => {
		const parser = new SimpleXmlParser()

		expect(nodeText(parser.parse('<a>  hello  </a>')[0])).toBe('hello')
		expect(nodeText(parser.parse('<a> \t\n </a>')[0])).toBe('')
		// Internal whitespace inside the trimmed segment is preserved verbatim.
		expect(nodeText(parser.parse('<a>two  words</a>')[0])).toBe('two  words')
	})

	test('keeps tag delimiters and equals literal inside quoted attribute values', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<a b="1<2>3/=4"/>')).toEqual([{ name: 'a', attributes: { b: '1<2>3/=4' }, children: [], text: EMPTY_TEXT }])
	})

	test('reads an empty attribute value followed by another attribute', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<a b="" c="2"/>')).toEqual([{ name: 'a', attributes: { b: '', c: '2' }, children: [], text: EMPTY_TEXT }])
	})

	test('streams an empty attribute value split across chunks', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<a b="')).toBeEmpty()
		expect(parser.parse('" c="2"/>')).toEqual([{ name: 'a', attributes: { b: '', c: '2' }, children: [], text: EMPTY_TEXT }])
	})

	test('allows whitespace inside closing and self-closing tags', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person></person >')).toEqual([{ name: 'person', attributes: {}, children: [], text: EMPTY_TEXT }])
		expect(parser.parse('<person/ >')).toEqual([{ name: 'person', attributes: {}, children: [], text: EMPTY_TEXT }])
	})

	test('ignores stray characters between and before top-level nodes', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('garbage<a/>between<b/>trailing')).toEqual([
			{ name: 'a', attributes: {}, children: [], text: EMPTY_TEXT },
			{ name: 'b', attributes: {}, children: [], text: EMPTY_TEXT },
		])
	})

	test('parses Buffer and Uint8Array input', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse(Buffer.from('<a x="1"/>'))).toEqual([{ name: 'a', attributes: { x: '1' }, children: [], text: EMPTY_TEXT }])
		expect(parser.parse(new TextEncoder().encode('<b y="2"/>'))).toEqual([{ name: 'b', attributes: { y: '2' }, children: [], text: EMPTY_TEXT }])
	})

	test('streams multibyte characters split one byte per chunk', () => {
		const parser = new SimpleXmlParser()
		const bytes = new TextEncoder().encode('<a x="café 😎">hï</a>')
		const out: XmlNode[] = []

		// Feeding a single byte at a time splits multibyte UTF-8 sequences across parse() calls.
		for (const byte of bytes) {
			for (const node of parser.parse(Uint8Array.of(byte))) out.push(node)
		}

		expect(out).toEqual([{ name: 'a', attributes: { x: 'café 😎' }, children: [], text: encodeText('hï') }])
	})
})

describe('errors and recovery', () => {
	test('rejects malformed structures', () => {
		expect(() => new SimpleXmlParser().parse('<a></a b>')).toThrow('invalid closing tag syntax')
		expect(() => new SimpleXmlParser().parse('<a></a=b>')).toThrow('invalid closing tag character')
		expect(() => new SimpleXmlParser().parse('<a/x>')).toThrow('invalid self-closing tag character')
		expect(() => new SimpleXmlParser().parse('<a b@="1"/>')).toThrow('invalid attribute name character')
		expect(() => new SimpleXmlParser().parse('</>')).toThrow('missing closing tag name')
		expect(() => new SimpleXmlParser().parse('</person>')).toThrow('mismatched closing tag: expected none, received person')
	})

	test('rejects XML declarations and comments (outside the supported subset)', () => {
		expect(() => new SimpleXmlParser().parse('<?xml version="1.0"?>')).toThrow('invalid tag start character')
		expect(() => new SimpleXmlParser().parse('<!-- comment -->')).toThrow('invalid tag start character')
	})

	test('resets internal state after a failure so the parser stays reusable', () => {
		const parser = new SimpleXmlParser()

		expect(() => parser.parse('<a></b>')).toThrow('mismatched closing tag')
		// #fail() calls reset(), so a fresh well-formed document parses cleanly afterwards.
		expect(parser.parse('<a/>')).toEqual([{ name: 'a', attributes: {}, children: [], text: EMPTY_TEXT }])
	})

	test('reset() clears a partially parsed tree', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<a><b>')).toBeEmpty()
		parser.reset()
		expect(parser.parse('<c/>')).toEqual([{ name: 'c', attributes: {}, children: [], text: EMPTY_TEXT }])
	})
})
