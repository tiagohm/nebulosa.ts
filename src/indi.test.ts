import { describe, expect, test } from 'bun:test'
import { IndiXmlParser, type IndiXmlElement } from './indi'

function parse(parser: IndiXmlParser, text: string) {
	const tags: IndiXmlElement[] = []

	for (const chunk of text) {
		tags.push(...parser.parse(Buffer.from(chunk)))
	}

	return tags
}

describe('parse', () => {
	test('oneTag', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('')
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithText', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a>b</a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('b')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithBreakLineAsText', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a>\nb\n</a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('b')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithOneAttribute', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<person age="30"></person>')[0]
		expect(tag.name).toBe('person')
		expect(tag.text).toBe('')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({ age: '30' })
	})

	test('oneTagWithEmptyAttribute', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<person gender=""></person>')[0]
		expect(tag.name).toBe('person')
		expect(tag.text).toBe('')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({ gender: '' })
	})

	test('oneTagWithTwoAttributes', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<person age="32" gender="male"></person>')[0]
		expect(tag.name).toBe('person')
		expect(tag.text).toBe('')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({ age: '32', gender: 'male' })
	})

	test('oneTagWithTwoAttributesAndText', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<person age="32" gender="male">Text</person>')[0]
		expect(tag.name).toBe('person')
		expect(tag.text).toBe('Text')
		expect(tag.children).toBeEmpty()
		expect(tag.attributes).toEqual({ age: '32', gender: 'male' })
	})

	test('oneTagWithOneNestedTag', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a><b></b></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([{ name: 'b', attributes: {}, text: '', children: [] }])
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithOneNestedTagAndAttributes', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a><person age="32" gender="male"></person></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([{ name: 'person', attributes: { age: '32', gender: 'male' }, text: '', children: [] }])
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithOneNestedTagAndAttributesAndText', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a><person age="32" gender="male">Text</person></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([{ name: 'person', attributes: { age: '32', gender: 'male' }, text: 'Text', children: [] }])
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithTwoNestedTags', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a><b></b><c></c></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([
			{ name: 'b', attributes: {}, text: '', children: [] },
			{ name: 'c', attributes: {}, text: '', children: [] },
		])
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithTwoNestedTagsAndAttributes', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a><person age="32" gender="male"></person><person age="32" gender="male"></person></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([
			{ name: 'person', attributes: { age: '32', gender: 'male' }, text: '', children: [] },
			{ name: 'person', attributes: { age: '32', gender: 'male' }, text: '', children: [] },
		])
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithTwoNestedTagsAndAttributesAndText', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a><person age="32" gender="male">Text</person><person age="32" gender="male">Text</person></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([
			{ name: 'person', attributes: { age: '32', gender: 'male' }, text: 'Text', children: [] },
			{ name: 'person', attributes: { age: '32', gender: 'male' }, text: 'Text', children: [] },
		])
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithMultipleNestedTags', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a><b><c><d><e></e></d></c></b></a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBeEmpty()
		expect(tag.children).toEqual([{ name: 'b', attributes: {}, text: '', children: [{ name: 'c', attributes: {}, text: '', children: [{ name: 'd', attributes: {}, text: '', children: [{ name: 'e', attributes: {}, text: '', children: [] }] }] }] }])
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithOneNestedTagAndText', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a>Te<b></b>xt</a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('Text')
		expect(tag.children).toEqual([{ name: 'b', attributes: {}, text: '', children: [] }])
		expect(tag.attributes).toEqual({})
	})

	test('oneTagWithTwoNestedTagsAndText', () => {
		const parser = new IndiXmlParser()
		const tag = parse(parser, '<a>Te<b></b>x<c></d>t</a>')[0]
		expect(tag.name).toBe('a')
		expect(tag.text).toBe('Text')
		expect(tag.children).toEqual([
			{ name: 'b', attributes: {}, text: '', children: [] },
			{ name: 'c', attributes: {}, text: '', children: [] },
		])
		expect(tag.attributes).toEqual({})
	})

	test('multipleTags', () => {
		const parser = new IndiXmlParser()
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
