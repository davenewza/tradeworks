# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a full-stack quote management application built with Keel (backend framework) and Vue 3 (frontend). The application allows customers to create and manage quotes for products with delivery calculations, supporting multiple brands, price lists, and delivery addresses.

## Technology Stack

**Backend (Keel Framework):**
- Keel schema-driven development with `.keel` files
- TypeScript functions for custom business logic
- Kysely for database queries
- Node-fetch for external API calls
- Vitest for testing

**Frontend:**
- Vue 3 (Composition API available but Options API primarily used)
- Vite for build tooling
- Tailwind CSS for styling
- Sentry for error tracking
- Vercel Analytics for user analytics
- Vercel Speed Insights for performance monitoring

## Commands

### Backend Development
```bash
cd backend

# Run tests
npx vitest

# Run a single test file
npx vitest path/to/test-file.test.ts

# Type checking
npx tsc --noEmit
```

### Frontend Development
```bash
cd frontend

# Start development server (runs on port 3000)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Backend Build
The Keel framework automatically generates TypeScript SDK files in `backend/.build/sdk` based on the schema files. These generated files should not be edited directly.

## Architecture

### Backend Structure

**Schema-Driven Development:**
- Schema files in `backend/schemas/*.keel` define models, actions, and permissions
- Keel generates API endpoints and TypeScript types from schemas
- Custom business logic implemented in `backend/functions/*.ts`

**Key Schema Files:**
- `products.keel` - Brand, Product, EquipmentBox models
- `pricing.keel` - PriceList, ProductPrice, CustomerPriceList models
- `customer.keel` - Customer and DeliveryAddress models
- `quotes.keel` - Quote, QuoteProduct, QuoteEquipmentBox models
- `shipments.keel` - Shipment tracking

**Custom Functions:**
The `backend/functions/` directory contains TypeScript implementations for custom actions defined in schemas with the `write` keyword:
- `calculateDelivery.ts` - Calculates shipping costs via ShipLogic API
- `calculateEquipmentBoxes.ts` - Determines required boxes based on product volumes
- `resetDeliveryInfo.ts` - Clears delivery calculation data

**Tools Directory:**
`backend/tools/` contains JSON files with example request/response data for API endpoints, useful for testing and documentation.

**Authentication:**
- Google OAuth configured in `keelconfig.yaml`
- Auth handled via Keel's built-in authentication system
- User model links to Customer for multi-tenancy

**Permissions:**
- All actions use `@permission` decorators in schema files
- Most actions require `ctx.isAuthenticated`
- Quote modifications restricted to Draft status
- Computed fields use `@computed()` with formulas

### Frontend Structure

**Single-Page Application (SPA) Architecture:**
- Main app entry point: `frontend/src/main.js`
- Root component: `frontend/src/App.vue` (handles auth flow and routing)
- No formal router - state-based view switching

**Key Components:**
- `LoginForm.vue` - Google OAuth login
- `UserProfileDialog.vue` - New user profile completion
- `PriceListManager.vue` - Main application view for managing quotes
- `QuoteManager.vue` - Quote creation and editing
- `QuoteDetail.vue` - Quote view with product selection
- `DeliveryAddresses.vue` - Manage customer delivery addresses
- `AddProductModal.vue` - Product search and selection

**Services Layer:**
All API communication goes through service files in `frontend/src/services/`:
- `authService.js` - Authentication, token management
- `customerService.js` - Customer data
- `priceListService.js` - Price list operations
- `quoteService.js` - Quote CRUD operations
- `productService.js` - Product search and retrieval
- `deliveryService.js` - Delivery calculation
- `equipmentBoxService.js` - Box calculation
- `userService.js` - User management

**API Communication:**
- Base URL from `frontend/src/config/api.js`
- Bearer token authentication
- All requests go through `/api` proxy in development (configured in `vite.config.js`)

**State Management:**
- No Vuex/Pinia - component-level state management
- Authentication state in `App.vue`
- Customer context passed via props

## API Reference

The Keel backend exposes a JSON API at `/api/json/` with 67 endpoints. All API requests:
- Use POST method
- Accept/return `application/json`
- Require Bearer token authentication (except auth endpoints)
- Follow the pattern: `POST /api/json/{operationId}`

**OpenAPI Specification:**
When Keel is running locally, the full OpenAPI 3.1 spec is available at:
```
http://localhost:8000/api/json/openapi.json
```

### API Endpoint Categories

**Authentication & User Management:**
- `createMe` - Create user account
- `getMe` - Get current authenticated user
- `getUser` - Get user by ID
- `listUsers` - List all users
- `assignToCustomer` - Assign user to customer
- `updateName` - Update user name
- `requestPasswordReset` - Request password reset
- `resetPassword` - Reset password with token

**Brands:**
- `createBrand` - Create new brand
- `getBrand` - Get brand by ID
- `listBrands` - List all brands
- `updateBrandName` - Update brand name
- `updateBrandLogo` - Update brand logo

**Products:**
- `createProduct` - Create new product
- `getProduct` - Get product by ID
- `listProducts` - List products (filterable by name, sku, brand)
- `updateProduct` - Update product details
- `updateProductDimensions` - Update product dimensions/weight
- `disableProduct` - Disable product (soft delete)

**Equipment Boxes:**
- `createEquipmentBox` - Create equipment box type
- `getEquipmentBox` - Get equipment box by ID
- `listEquipmentBoxes` - List equipment boxes (by box type)
- `updateEquipmentBox` - Update equipment box
- `updateEquipmentBoxImage` - Update equipment box image
- `disableEquipmentBox` - Disable equipment box

**Customers:**
- `createCustomer` - Create new customer
- `getCustomer` - Get customer by ID
- `listCustomers` - List all customers

**Delivery Addresses:**
- `createDeliveryAddress` - Create delivery address for customer
- `getDeliveryAddress` - Get delivery address by ID
- `listDeliveryAddresses` - List customer delivery addresses
- `updateDeliveryAddress` - Update delivery address
- `deactivateDeliveryAddress` - Deactivate delivery address

**Price Lists:**
- `createPriceList` - Create new price list
- `getPriceList` - Get price list by ID
- `listPriceLists` - List all price lists
- `updatePriceList` - Update price list details
- `deletePriceList` - Delete price list
- `listPriceListChangeLog` - Get price list change history

**Product Prices:**
- `createProductPrice` - Create product price for price list
- `getProductPrice` - Get product price by ID
- `listProductPrices` - List product prices (by price list/product)
- `updateProductPrice` - Update product price
- `deleteProductPrice` - Delete product price

**Customer Price Lists:**
- `createCustomerPriceList` - Assign price list to customer
- `listCustomerPriceLists` - List customer's assigned price lists
- `deleteCustomerPriceList` - Remove price list from customer

**Quotes:**
- `createQuote` - Create new quote (requires customerPriceList)
- `getQuote` - Get quote by ID
- `listQuotes` - List quotes (filterable by customer, status)
- `listDraftQuotes` - List draft quotes (sortable)
- `listSubmittedQuotes` - List submitted quotes (sortable)
- `listApprovedQuotes` - List approved quotes (sortable)
- `updateQuoteName` - Update quote name
- `updateQuoteDeliveryAddress` - Assign delivery address to quote
- `updateQuoteDelivery` - Update delivery service and fees
- `submitQuote` - Submit quote (Draft → Submitted)
- `approveQuote` - Approve quote (Submitted → Approved)
- `deleteQuote` - Delete quote (Draft only)

**Quote Products:**
- `createQuoteProduct` - Add product to quote
- `listQuoteProducts` - List products in quote
- `updateQuoteProduct` - Update product quantity
- `deleteQuoteProduct` - Remove product from quote

**Quote Equipment Boxes:**
- `listQuoteEquipmentBoxes` - List equipment boxes for quote

**Custom Business Logic:**
- `calculateEquipmentBoxes` - Calculate required boxes for quote
- `calculateDelivery` - Calculate shipping costs via ShipLogic
- `resetDeliveryInfo` - Clear delivery calculation data

### Request/Response Format

**Standard Request:**
```json
{
  "id": "string",           // For get/update/delete operations
  "where": { ... },         // For filtered operations
  "values": { ... },        // For update operations
  // Action-specific fields
}
```

**List Request (Pagination):**
```json
{
  "where": { ... },
  "orderBy": [...],
  "limit": 100,
  "offset": 0,
  "first": 50,              // Cursor-based pagination
  "after": "cursor",
  "before": "cursor",
  "last": 50
}
```

**Standard Response:**
```json
{
  // Single object for get/create/update
  // OR
  "results": [...],
  "pageInfo": {
    "count": 10,
    "totalCount": 100,
    "hasNextPage": true,
    "startCursor": "...",
    "endCursor": "...",
    "pageNumber": 1
  }
}
```

**Error Response (400):**
```json
{
  "code": "string",
  "message": "string",
  "data": {
    "errors": [{
      "field": "string",
      "error": "string"
    }]
  }
}
```

### Example API Usage

**Creating a Quote:**
```javascript
const response = await fetch('/api/json/createQuote', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    customerPriceList: { id: 'cpl_123' }
  })
});
const quote = await response.json();
```

**Listing Products with Filters:**
```javascript
const response = await fetch('/api/json/listProducts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    where: {
      brand: { id: { equals: 'brand_123' } },
      name: { contains: 'coffee', mode: 'insensitive' }
    },
    limit: 50
  })
});
const { results, pageInfo } = await response.json();
```

## Development Guidelines

### Working with Keel Schemas

When modifying models or actions:
1. Edit the `.keel` schema files in `backend/schemas/`
2. Keel will regenerate the SDK on next build/run
3. Import types from `@teamkeel/sdk` in functions
4. Use `models.<modelName>` for database operations (e.g., `models.quote.findOne()`)

### Adding Custom Functions

For complex business logic that can't be expressed in schema:
1. Define the action in the schema with `write` keyword
2. Create TypeScript file in `backend/functions/` matching the action name
3. Import and use the action type from `@teamkeel/sdk`
4. Export default function with signature: `(ctx, inputs) => Promise<result>`

Example:
```typescript
import { CalculateDelivery, models } from '@teamkeel/sdk';

export default CalculateDelivery(async (ctx, inputs) => {
  // Implementation
});
```

### Frontend Service Pattern

All API calls should go through service files:
1. Import required types/utilities
2. Handle authentication tokens
3. Construct request with proper headers
4. Handle errors appropriately
5. Return data in expected format

### API Data Embedding Optimization

**Important:** Many list endpoints use `@embed()` directives to include related data in responses, eliminating the need for additional API calls:

**Endpoints with embedded data:**
- `listProductPrices` - Embeds full `product` object (via `@embed(product)`)
- `listQuoteProducts` - Embeds full `product` object (via `@embed(product)`)
- `listQuoteEquipmentBoxes` - Embeds full `equipmentBox` object (via `@embed(equipmentBox)`)
- `listCustomerPriceLists` - Embeds full `priceList` object (via `@embed(priceList)`)

**Best practices:**
- Always check if related data is already embedded before making individual GET requests
- Use embedded data directly from list responses: `productPrice.product`, `quoteProduct.product`, etc.
- Only call `getProduct()`, `getEquipmentBox()`, etc. when you need standalone entity data
- See `productService.js` and component implementations for examples

This pattern prevents N+1 query problems and significantly reduces API calls.

### Testing

Backend tests use Vitest. Test files should be colocated with the code being tested or in a `__tests__` directory.

### Environment Configuration

**Backend:**
- `keelconfig.yaml` - Development configuration
- `keelconfig.production.yaml` - Production overrides
- Environment variables defined in keelconfig files
- Secrets referenced but values stored securely

**Frontend:**
- `.env.local` - Local development (gitignored)
- `.env.production` - Production settings
- Access via `import.meta.env.VARIABLE_NAME`

## Important Patterns

### Quote Workflow
1. Quotes start in `Draft` status
2. Products added via QuoteProduct junction table
3. Equipment boxes calculated based on product dimensions and selected BoxType
4. Delivery calculated using ShipLogic API integration
5. Quote can be submitted → `Submitted` status
6. Approved quotes move to `Approved` status
7. Status transitions enforced via permissions

### Multi-Tenancy
- User accounts link to Customer via `customerId` field
- All data filtered by customer context
- CustomerPriceList links customers to specific price lists
- Permissions enforce customer-level isolation

### Computed Fields
Many fields use `@computed()` in schemas for calculated values:
- Quote totals (sum of products + equipment + delivery)
- VAT calculations (15%)
- Product volumes
- Weighted totals

### Box Packing Algorithm
`calculateEquipmentBoxes.ts` implements a bin-packing algorithm to determine optimal box quantities based on product volumes and dimensions.

### Error Tracking with Sentry

- Sentry is initialized in `frontend/src/main.js`
- Captures frontend errors and exceptions
- Sends user context with errors (`sendDefaultPii: true`)
