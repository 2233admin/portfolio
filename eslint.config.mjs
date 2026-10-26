import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import reactPlugin from "eslint-plugin-react";
import globals from "globals";

export default [
    js.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                ecmaFeatures: { jsx: true },
                ecmaVersion: "latest",
                sourceType: "module",
            },
        },
        plugins: {
            prettier: prettierPlugin,
            react: reactPlugin,
        },
        rules: {
            ...prettierConfig.rules,
            "prettier/prettier": "error",
            "arrow-body-style": "off",
            "prefer-arrow-callback": "off",
            "react/jsx-uses-vars": "error",
            "react/jsx-uses-react": "off",
        },
    },
    {
        ignores: [".next/**", "node_modules/**", "out/**", "bench/koi-pond/out/**"],
    },
];
