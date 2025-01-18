import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	eslint.configs.recommended,
	tseslint.configs.strictTypeChecked,
	tseslint.configs.stylisticTypeCheckedOnly,
	{
		languageOptions: {
			parserOptions: {
				ecmaVersion: 2024,
				parser: tseslint.parser,
				projectService: true,
				project: './tsconfig.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ['**/*.ts'],
		rules: {
			'no-unused-vars': 'off',
			'no-loss-of-precision': 'off',
			'no-extra-semi': 'warn',
			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/restrict-template-expressions': 'off',
			'@typescript-eslint/no-misused-promises': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/consistent-type-imports': 'error',
			'@typescript-eslint/no-empty-interface': 'error',
			'@typescript-eslint/consistent-return': 'error',
			'@typescript-eslint/consistent-indexed-object-style': 'error',
			'@typescript-eslint/prefer-readonly': 'error',
			'@typescript-eslint/consistent-type-assertions': 'error',
			'@typescript-eslint/consistent-type-definitions': 'error',
			'@typescript-eslint/prefer-nullish-coalescing': [
				'error',
				{
					ignorePrimitives: true,
				},
			],
			'@typescript-eslint/no-unused-expressions': [
				'error',
				{
					allowShortCircuit: true,
					allowTernary: true,
				},
			],
			'@typescript-eslint/no-unnecessary-condition': [
				'error',
				{
					allowConstantLoopConditions: true,
				},
			],
		},
	},
)
