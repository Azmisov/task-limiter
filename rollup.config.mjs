import babel from '@rollup/plugin-babel';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from "@rollup/plugin-terser";

export default [
	{
		input: "tasklimiter.mjs",
		output: {
			file: "tasklimiter.compat.min.js",
			name: "TaskLimiter",
			format: "iife"
		},
		plugins: [
			babel({ babelHelpers: 'bundled' }),
			nodeResolve(),
			terser()
		]
	},
	{
		input: "tasklimiter.mjs",
		output: {
			file: "tasklimiter.min.mjs"
		},
		plugins: [ terser() ]
	}
];