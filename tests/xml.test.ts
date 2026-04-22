import { describe, expect, test } from 'bun:test'
import { SimpleXmlParser } from '../src/xml'

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
