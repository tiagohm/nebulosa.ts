import { describe, expect, test } from 'bun:test'
import { SimpleXmlParser, type SimpleXmlElement } from './indi'

function parse(parser: SimpleXmlParser, text: string) {
	const tags: SimpleXmlElement[] = []

	for (const chunk of text) {
		tags.push(...parser.parse(Buffer.from(chunk)))
	}

	return tags
}

describe('parse', () => {
	test('simple', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('')
		expect(tag.attributes).toEqual({})
	})

	test('withText', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a>b</a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('b')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({})
	})

	test('withBreakLineAsText', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a>\nb\n</a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('b')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({})
	})

	test('withOneAttribute', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<person age="30"></person>')[0]
		expect(tag.name).toBe('person')
		expect(tag.text).toBe('')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({ age: '30' })
	})

	test('withEmptyAttribute', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<person gender=""></person>')[0]
		expect(tag.name).toBe('person')
		expect(tag.text).toBe('')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({ gender: '' })
	})

	test('withTwoAttributes', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<person age="32" gender="male"></person>')[0]
		expect(tag.name).toBe('person')
		expect(tag.text).toBe('')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({ age: '32', gender: 'male' })
	})

	test('withTwoAttributesAndText', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<person age="32" gender="male">Text</person>')[0]
		expect(tag.name).toBe('person')
		expect(tag.text).toBe('Text')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({ age: '32', gender: 'male' })
	})

	test('withOneNestedTag', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a><b></b></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([{ name: 'b', attributes: {}, text: '', children: [] }])
		expect(tag.attributes).toEqual({})
	})

	test('withOneNestedTagAndAttributes', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a><person age="32" gender="male"></person></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([{ name: 'person', attributes: { age: '32', gender: 'male' }, text: '', children: [] }])
		expect(tag.attributes).toEqual({})
	})

	test('withOneNestedTagAndAttributesAndText', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a><person age="32" gender="male">Text</person></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([{ name: 'person', attributes: { age: '32', gender: 'male' }, text: 'Text', children: [] }])
		expect(tag.attributes).toEqual({})
	})

	test('withTwoNestedTags', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a><b></b><c></c></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([
			{ name: 'b', attributes: {}, text: '', children: [] },
			{ name: 'c', attributes: {}, text: '', children: [] },
		])
		expect(tag.attributes).toEqual({})
	})

	test('withTwoNestedTagsAndAttributes', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a><person age="32" gender="male"></person><person age="32" gender="male"></person></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([
			{ name: 'person', attributes: { age: '32', gender: 'male' }, text: '', children: [] },
			{ name: 'person', attributes: { age: '32', gender: 'male' }, text: '', children: [] },
		])
		expect(tag.attributes).toEqual({})
	})

	test('withTwoNestedTagsAndAttributesAndText', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a><person age="32" gender="male">Text</person><person age="32" gender="male">Text</person></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([
			{ name: 'person', attributes: { age: '32', gender: 'male' }, text: 'Text', children: [] },
			{ name: 'person', attributes: { age: '32', gender: 'male' }, text: 'Text', children: [] },
		])
		expect(tag.attributes).toEqual({})
	})

	test('withMultipleNestedTags', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a><b><c><d><e></e></d></c></b></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([{ name: 'b', attributes: {}, text: '', children: [{ name: 'c', attributes: {}, text: '', children: [{ name: 'd', attributes: {}, text: '', children: [{ name: 'e', attributes: {}, text: '', children: [] }] }] }] }])
		expect(tag.attributes).toEqual({})
	})

	test('withOneNestedTagAndText', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a>Te<b></b>xt</a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('Text')
		expect(tag.children).toEqual([{ name: 'b', attributes: {}, text: '', children: [] }])
		expect(tag.attributes).toEqual({})
	})

	test('withTwoNestedTagsAndText', () => {
		const parser = new SimpleXmlParser()
		const tag = parse(parser, '<a>Te<b></b>x<c></d>t</a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('Text')
		expect(tag.children).toEqual([
			{ name: 'b', attributes: {}, text: '', children: [] },
			{ name: 'c', attributes: {}, text: '', children: [] },
		])
		expect(tag.attributes).toEqual({})
	})

	test('withMultipleTags', () => {
		const parser = new SimpleXmlParser()
		const tags = parse(parser, '<a></a><b></b>')
		expect(tags).toHaveLength(2)
		expect(tags[0].name).toBe('a')
		expect(tags[0].text).toEqual('')
		expect(tags[0].children).toBeEmpty()
		expect(tags[0].attributes).toEqual({})
		expect(tags[1].name).toBe('b')
		expect(tags[1].text).toEqual('')
		expect(tags[1].attributes).toEqual({})
		expect(tags[1].children).toBeEmpty()
	})
})
