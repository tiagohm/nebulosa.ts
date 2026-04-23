import { $ } from 'bun'

const output = await $`bunx oxlint --rules`.quiet()
const text = output.text()
const lines = text.split('\n')

let category = ''
let categoryDescription = ''
const rulesByCategory = new Map<string, string[]>()
const rules = []

const configuredRules: Record<string, object> = {
	'eslint/no-unused-expressions': { allowShortCircuit: true, allowTernary: true },
	'typescript/prefer-nullish-coalescing': { ignorePrimitives: true },
	'unicorn/no-instanceof-builtins': { exclude: ['Function', 'Array'] },
	'typescript/prefer-string-starts-ends-with': { allowSingleElementEquality: 'always' },
}

const alwaysDisabledRules = new Set(['unicorn/prefer-string-starts-ends-with'])
// https://oxc.rs/docs/guide/usage/linter/plugins.html#supported-plugins
const enabledPlugins = new Set(['typescript', 'eslint', 'oxc', 'promise', 'unicorn', 'import'])

for (let i = 0; i < lines.length; i++) {
	const line = lines[i]

	if (line.startsWith('##')) {
		category = line.slice(3)
		categoryDescription = lines[++i]
		rulesByCategory.set(category, [])
		i += 2
		continue
	}

	if (!line.startsWith('|')) continue

	const columns = line.split('|')
	const source = columns[2].trim()

	const isPluginEnabled = enabledPlugins.has(source)

	if (!isPluginEnabled) continue

	const ruleName = columns[1].trim()
	const fullRuleName = `${source}/${ruleName}`
	const enabled = isPluginEnabled && columns[4].trim() === '✅' && !alwaysDisabledRules.has(fullRuleName)

	const configuredRule = configuredRules[fullRuleName] ?? configuredRules[ruleName]
	const value = configuredRule ? `["error", ${JSON.stringify(configuredRule)}]` : enabled ? '"error"' : '"off"'
	rulesByCategory.get(category)!.push(`"${fullRuleName}": ${value},`)
}

let total = 0
let totalEnabled = 0

for (const [key, values] of rulesByCategory) {
	rules.push(`// ${key}`)

	values.sort()
	total += values.length

	for (const value of values) {
		rules.push(value)
		if (value.includes('"error"')) totalEnabled++
	}
}

console.info(totalEnabled, 'of', total)

const content = `
{
	"$schema": "./node_modules/oxlint/configuration_schema.json",
	"ignorePatterns": ["*.data.ts"],
	"plugins": [${[...enabledPlugins].map((e) => `"${e}"`).join(',')}],
	"categories": {
		"correctness": "off",
		"pedantic": "off",
		"suspicious": "off",
		"perf": "off",
		"nursery": "off",
		"restriction": "off",
		"style": "off"
	},
	"options": {
		"typeAware": true,
		"typeCheck": true
	},
	"rules": {
	${rules.join('\n')}
	},
	"env": {
		"builtin": true
	}
}
`

await Bun.write('.oxlintrc.json', content)

await $`bunx oxfmt .oxlintrc.json`
