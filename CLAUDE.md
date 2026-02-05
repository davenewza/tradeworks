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

**External APIs:**
- Zoho Books API v3 for accounting integration (OpenAPI schema at `docs/zoho-books-api/`)
- ShipLogic API for delivery rate calculations

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

**OpenAPI Specification:**
When Keel is running locally, the full OpenAPI 3.1 spec is available at:
```
http://localhost:8000/api/json/openapi.json
```

### API Endpoint Categories

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
