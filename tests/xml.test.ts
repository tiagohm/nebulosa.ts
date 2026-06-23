import { describe, expect, test } from 'bun:test'
import { SimpleXmlParser, type XmlNode } from '../src/xml'

const input = `
<person id="1" type="student">
    <name>
    John Doe
    </name>
    <age>25</age>
    <address city="New York"/>
</person>
`

describe('parse', () => {
	test('single', () => {
		const parser = new SimpleXmlParser()
		const [tag] = parser.parse(input)

		expect(tag).toBeDefined()
		expect(tag.name).toBe('person')
		expect(tag.attributes.id).toBe('1')
		expect(tag.attributes.type).toBe('student')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toHaveLength(3)
		expect(tag.children[0].name).toBe('name')
		expect(tag.children[0].text).toBe('John Doe')
		expect(tag.children[0].children).toBeEmpty()
		expect(tag.children[1].name).toBe('age')
		expect(tag.children[1].text).toBe('25')
		expect(tag.children[1].children).toBeEmpty()
		expect(tag.children[2].name).toBe('address')
		expect(tag.children[2].attributes.city).toBe('New York')
		expect(tag.children[2].text).toBe('')
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
			expect(tags[i].text).toBeEmpty()
			expect(tags[i].children).toHaveLength(3)
			expect(tags[i].children[0].name).toBe('name')
			expect(tags[i].children[0].text).toBe('John Doe')
			expect(tags[i].children[0].children).toBeEmpty()
			expect(tags[i].children[1].name).toBe('age')
			expect(tags[i].children[1].text).toBe('25')
			expect(tags[i].children[1].children).toBeEmpty()
			expect(tags[i].children[2].name).toBe('address')
			expect(tags[i].children[2].attributes.city).toBe('New York')
			expect(tags[i].children[2].text).toBe('')
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
		expect(tag.text).toBeEmpty()
		expect(tag.children).toHaveLength(3)
		expect(tag.children[0].name).toBe('name')
		expect(tag.children[0].text).toBe('John Doe')
		expect(tag.children[0].children).toBeEmpty()
		expect(tag.children[1].name).toBe('age')
		expect(tag.children[1].text).toBe('25')
		expect(tag.children[1].children).toBeEmpty()
		expect(tag.children[2].name).toBe('address')
		expect(tag.children[2].attributes.city).toBe('New York')
		expect(tag.children[2].text).toBe('')
		expect(tag.children[2].children).toBeEmpty()
	})

	test('edge cases', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person></person>')).toEqual([{ name: 'person', attributes: {}, children: [], text: '' }])
		expect(parser.parse('<person name="John"></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [], text: '' }])
		expect(parser.parse('<person name="John" disabled student></person>')).toEqual([{ name: 'person', attributes: { name: 'John', disabled: '', student: '' }, children: [], text: '' }])
		expect(parser.parse('<person gender=""></person>')).toEqual([{ name: 'person', attributes: { gender: '' }, children: [], text: '' }])
		expect(parser.parse('<person>Text</person>')).toEqual([{ name: 'person', attributes: {}, children: [], text: 'Text' }])
		expect(parser.parse('<person name="John"><phone number="5511987654321"></phone></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [{ name: 'phone', attributes: { number: '5511987654321' }, children: [], text: '' }], text: '' }])
		expect(parser.parse('<person name="John"><phone number="5511987654321" /></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [{ name: 'phone', attributes: { number: '5511987654321' }, children: [], text: '' }], text: '' }])
		expect(parser.parse('<person name="John"><phone country="55">11987654321</phone></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [{ name: 'phone', attributes: { country: '55' }, children: [], text: '11987654321' }], text: '' }])
		expect(parser.parse('<person name="John"><phone number="5511987654321"></phone><phone country="55">11976543210</phone></person>')).toEqual([
			{
				name: 'person',
				attributes: { name: 'John' },
				children: [
					{ name: 'phone', attributes: { number: '5511987654321' }, children: [], text: '' },
					{ name: 'phone', attributes: { country: '55' }, children: [], text: '11976543210' },
				],
				text: '',
			},
		])
		expect(parser.parse('<person name="John"><address><city>New York</city></address></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [{ name: 'address', attributes: {}, children: [{ name: 'city', attributes: {}, children: [], text: 'New York' }], text: '' }], text: '' }])
		expect(parser.parse('<person name="John"><address><city>New York</city><complement/></address></person>')).toEqual([
			{
				name: 'person',
				attributes: { name: 'John' },
				children: [
					{
						name: 'address',
						attributes: {},
						children: [
							{ name: 'city', attributes: {}, children: [], text: 'New York' },
							{ name: 'complement', attributes: {}, children: [], text: '' },
						],
						text: '',
					},
				],
				text: '',
			},
		])

		expect(parser.parse('<person/>')).toEqual([{ name: 'person', attributes: {}, children: [], text: '' }])
		expect(parser.parse('<person name="John"/>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [], text: '' }])
		expect(parser.parse('<person name="John" disabled student/>')).toEqual([{ name: 'person', attributes: { name: 'John', disabled: '', student: '' }, children: [], text: '' }])
		expect(parser.parse('<person gender=""/>')).toEqual([{ name: 'person', attributes: { gender: '' }, children: [], text: '' }])
	})

	test('mixed content after child tags', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person>John<phone/>Doe</person>')).toEqual([{ name: 'person', attributes: {}, children: [{ name: 'phone', attributes: {}, children: [], text: '' }], text: 'JohnDoe' }])
		expect(parser.parse('<person><phone></phone>Doe</person>')).toEqual([{ name: 'person', attributes: {}, children: [{ name: 'phone', attributes: {}, children: [], text: '' }], text: 'Doe' }])
	})

	test('preserve valid name characters', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person-data attr_name="1" attr-name="2" xmlns:x="3"></person-data>')).toEqual([
			{
				name: 'person-data',
				attributes: { attr_name: '1', 'attr-name': '2', 'xmlns:x': '3' },
				children: [],
				text: '',
			},
		])
	})

	test('treat tabs and newlines as tag whitespace', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person\tname="John"></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [], text: '' }])
		expect(parser.parse('<person\nname="John"></person>')).toEqual([{ name: 'person', attributes: { name: 'John' }, children: [], text: '' }])
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
		expect(parser.parse('text</person>')).toEqual([{ name: 'person', attributes: { id: '1' }, children: [], text: 'text' }])
	})

	test('trims surrounding whitespace and drops whitespace-only text', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<a>  hello  </a>')[0].text).toBe('hello')
		expect(parser.parse('<a> \t\n </a>')[0].text).toBe('')
		// Internal whitespace inside the trimmed segment is preserved verbatim.
		expect(parser.parse('<a>two  words</a>')[0].text).toBe('two  words')
	})

	test('keeps tag delimiters and equals literal inside quoted attribute values', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<a b="1<2>3/=4"/>')).toEqual([{ name: 'a', attributes: { b: '1<2>3/=4' }, children: [], text: '' }])
	})

	test('reads an empty attribute value followed by another attribute', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<a b="" c="2"/>')).toEqual([{ name: 'a', attributes: { b: '', c: '2' }, children: [], text: '' }])
	})

	test('allows whitespace inside closing and self-closing tags', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<person></person >')).toEqual([{ name: 'person', attributes: {}, children: [], text: '' }])
		expect(parser.parse('<person/ >')).toEqual([{ name: 'person', attributes: {}, children: [], text: '' }])
	})

	test('ignores stray characters between and before top-level nodes', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('garbage<a/>between<b/>trailing')).toEqual([
			{ name: 'a', attributes: {}, children: [], text: '' },
			{ name: 'b', attributes: {}, children: [], text: '' },
		])
	})

	test('parses Buffer and Uint8Array input', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse(Buffer.from('<a x="1"/>'))).toEqual([{ name: 'a', attributes: { x: '1' }, children: [], text: '' }])
		expect(parser.parse(new TextEncoder().encode('<b y="2"/>'))).toEqual([{ name: 'b', attributes: { y: '2' }, children: [], text: '' }])
	})

	test('streams multibyte characters split one byte per chunk', () => {
		const parser = new SimpleXmlParser()
		const bytes = new TextEncoder().encode('<a x="café 😎">hï</a>')
		const out: XmlNode[] = []

		// Feeding a single byte at a time splits multibyte UTF-8 sequences across parse() calls.
		for (const byte of bytes) {
			for (const node of parser.parse(Uint8Array.of(byte))) out.push(node)
		}

		expect(out).toEqual([{ name: 'a', attributes: { x: 'café 😎' }, children: [], text: 'hï' }])
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
		expect(parser.parse('<a/>')).toEqual([{ name: 'a', attributes: {}, children: [], text: '' }])
	})

	test('reset() clears a partially parsed tree', () => {
		const parser = new SimpleXmlParser()

		expect(parser.parse('<a><b>')).toBeEmpty()
		parser.reset()
		expect(parser.parse('<c/>')).toEqual([{ name: 'c', attributes: {}, children: [], text: '' }])
	})
})
