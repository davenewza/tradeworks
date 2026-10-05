import { describe, expect, test } from 'vitest';
import { fetchProductStock, isCompositeItem, parseStockItems, ZohoStockItem } from './zohoStockHelpers';
import { ZohoApiError, ZohoGet } from './zohoInventoryApi';

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
            { item_id: '1', sku: 'A', actual_available_stock: '19' },     // string → 19
            { item_id: '2', sku: 'B', actual_available_stock: 76 },       // number kept
            { item_id: '3', sku: 'C', actual_available_stock: '-3' },     // negative preserved (invoiced ahead of stock)
            { item_id: '10', sku: '  I  ', actual_available_stock: '0' }, // trimmed sku, zero is valid stock
        ];
        expect(parseStockItems(items)).toEqual([
            { sku: 'A', stockAvailable: 19 },
            { sku: 'B', stockAvailable: 76 },
            { sku: 'C', stockAvailable: -3 },
            { sku: 'I', stockAvailable: 0 },
        ]);
    });

    test('reads physical stock, not stock_on_hand, which counts an order from the day it is billed', () => {
        // MEFV22G as the org had it on 2026-10-05: 100 on the shelf, and an
        // order for 100 more billed but not received.
        const item = { item_id: '1', sku: 'MEFV22G', stock_on_hand: 200, actual_available_stock: 100 } as ZohoStockItem;
        expect(parseStockItems([item])).toEqual([{ sku: 'MEFV22G', stockAvailable: 100 }]);
    });

    test('drops items that cannot give a meaningful stock figure', () => {
        const items: ZohoStockItem[] = [
            { item_id: '4', actual_available_stock: '5' },                                   // no sku
            { item_id: '5', sku: 'D', status: 'inactive', actual_available_stock: '5' },     // inactive
            { item_id: '6', sku: 'E', is_combo_product: true, actual_available_stock: '5' }, // composite
            { item_id: '7', sku: 'F' },                                                      // no stock field
            { item_id: '8', sku: 'G', actual_available_stock: '' },                          // empty string
            { item_id: '9', sku: 'H', actual_available_stock: 'abc' },                       // non-numeric
            { item_id: '11', sku: 'J', actual_available_stock: null },                       // null
        ];
        expect(parseStockItems(items)).toEqual([]);
    });
});

describe('fetchProductStock', () => {
    const page = (skus: string[], hasMore: boolean) => ({
        items: skus.map((sku) => ({ item_id: sku, sku, actual_available_stock: 1 })),
        page_context: { has_more_page: hasMore },
    });

    test('pages through every active item', async () => {
        const queries: Record<string, string>[] = [];
        const get: ZohoGet = async (path, query = {}) => {
            expect(path).toBe('/items');
            queries.push(query);
            return query.page === '1' ? page(['A', 'B'], true) : page(['C'], false);
        };

        const result = await fetchProductStock(get);

        expect(result).toEqual({ stock: ['A', 'B', 'C'].map((sku) => ({ sku, stockAvailable: 1 })), rateLimited: false });
        expect(queries).toEqual([
            { filter_by: 'Status.Active', page: '1', per_page: '200' },
            { filter_by: 'Status.Active', page: '2', per_page: '200' },
        ]);
    });

    test("stops at Zoho's daily limit with what it has read", async () => {
        const get: ZohoGet = async (path, query = {}) => {
            if (query.page === '1') return page(['A'], true);
            throw new ZohoApiError(path, 429, '{"code":45,"message":"You have reached the maximum number of API calls for the day."}');
        };

        expect(await fetchProductStock(get)).toEqual({ stock: [{ sku: 'A', stockAvailable: 1 }], rateLimited: true });
    });

    test('fails on any other error', async () => {
        const get: ZohoGet = async (path) => {
            throw new ZohoApiError(path, 500, 'Internal error');
        };

        await expect(fetchProductStock(get)).rejects.toThrow('Zoho GET /items failed: 500');
    });
});
