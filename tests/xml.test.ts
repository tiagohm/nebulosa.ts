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
})
