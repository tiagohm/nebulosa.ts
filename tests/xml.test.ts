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

		expect(tag).not.toBeUndefined()
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

		const [tag] = parser.parse(lines[lines.length - 1])

		expect(tag).not.toBeUndefined()
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
})
