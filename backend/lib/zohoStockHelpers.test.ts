import { describe, expect, test } from 'vitest';
import { isCompositeItem, parseStockItems, ZohoStockItem } from './zohoStockHelpers';

describe('isCompositeItem', () => {
    test('detects composites across the flags Zoho uses', () => {
        expect(isCompositeItem({ item_id: '1', is_combo_product: true })).toBe(true);
        expect(isCompositeItem({ item_id: '1', item_type: 'combo_product' })).toBe(true);
        expect(isCompositeItem({ item_id: '1', combo_type: 'composite' })).toBe(true);
    });

    test('leaves ordinary inventory items alone', () => {
        expect(isCompositeItem({ item_id: '1', item_type: 'inventory', is_combo_product: false })).toBe(false);
        expect(isCompositeItem({ item_id: '1' })).toBe(false);
    });
});

describe('parseStockItems', () => {
    test('keeps active, stocked, non-composite items and coerces stock to a number', () => {
        const items: ZohoStockItem[] = [
            { item_id: '1', sku: 'A', stock_on_hand: '19' },       // string → 19
            { item_id: '2', sku: 'B', stock_on_hand: 76 },         // number kept
            { item_id: '3', sku: 'C', stock_on_hand: '-3' },       // negative preserved (billed ahead of stock)
            { item_id: '10', sku: '  I  ', stock_on_hand: '0' },   // trimmed sku, zero is valid stock
        ];
        expect(parseStockItems(items)).toEqual([
            { sku: 'A', stockAvailable: 19 },
            { sku: 'B', stockAvailable: 76 },
            { sku: 'C', stockAvailable: -3 },
            { sku: 'I', stockAvailable: 0 },
        ]);
    });

    test('drops items that cannot give a meaningful stock figure', () => {
        const items: ZohoStockItem[] = [
            { item_id: '4', stock_on_hand: '5' },                                  // no sku
            { item_id: '5', sku: 'D', status: 'inactive', stock_on_hand: '5' },    // inactive
            { item_id: '6', sku: 'E', is_combo_product: true, stock_on_hand: '5' },// composite
            { item_id: '7', sku: 'F' },                                            // no stock field
            { item_id: '8', sku: 'G', stock_on_hand: '' },                         // empty string
            { item_id: '9', sku: 'H', stock_on_hand: 'abc' },                      // non-numeric
            { item_id: '11', sku: 'J', stock_on_hand: null },                      // null
        ];
        expect(parseStockItems(items)).toEqual([]);
    });
});
