// Guards the Console create forms against hiding a required relation input.
//
// A hidden input is only ever filled by an entry point whose link carries a
// data_mapping for it (e.g. the "Add product" button on a price list page).
// Every other way into the same form — a list's create button, including the
// ones on embedded lists — submits the hidden relation as `{}`, and the API
// rejects it with "Must have required property 'id'". So a required relation
// has to stay visible: mapped entry points still prefill it, and the rest let
// the operator pick it.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const backendDir = fileURLToPath(new URL('..', import.meta.url));

// Maps each create action to the relations its `with (...)` inputs require,
// e.g. createProductPrice -> ["product", "priceList"].
function requiredRelationsByCreateAction(): Map<string, string[]> {
    const schemasDir = join(backendDir, 'schemas');
    const actions = new Map<string, string[]>();

    for (const file of readdirSync(schemasDir).filter((f) => f.endsWith('.keel'))) {
        const source = readFileSync(join(schemasDir, file), 'utf8').replace(/\/\/.*$/gm, '');

        for (const match of source.matchAll(/\bcreate\s+(\w+)\s*\([^)]*\)\s*with\s*\(([^)]*)\)/g)) {
            const relations = match[2]
                .split(',')
                .map((input) => input.trim())
                .filter((input) => input.includes('.') && !input.endsWith('?'))
                .map((input) => input.split('.')[0]);
            actions.set(match[1], [...new Set(relations)]);
        }
    }

    return actions;
}

describe('Console create tools', () => {
    test('never hide a required relation input', () => {
        const createActions = requiredRelationsByCreateAction();

        // The schema scan must actually find the actions, or the check below
        // passes vacuously.
        expect(createActions.get('createProductPrice')).toEqual(['product', 'priceList']);
        expect(createActions.get('createDiscountTier')).toEqual(['priceList']);

        const toolsDir = join(backendDir, 'tools');
        const hidden: string[] = [];

        for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))) {
            const tool = JSON.parse(readFileSync(join(toolsDir, file), 'utf8'));
            const relations = createActions.get(tool.action_name);
            if (!relations) continue;

            for (const [path, config] of Object.entries<{ visible?: boolean }>(tool.inputs ?? {})) {
                const field = path.replace(/^\$\./, '').split('.')[0];
                if (relations.includes(field) && config.visible === false) {
                    hidden.push(`${file}: ${path}`);
                }
            }
        }

        expect(hidden).toEqual([]);
    });
});
