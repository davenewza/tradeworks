# Keel Framework Context

## Overview

Keel is an all-in-one backend platform for rapidly building scalable products. It provides a schema-driven development approach with automatic API generation, built-in permissions, and TypeScript function support.

**Documentation**: https://docs.keel.so/

---

## Core Concepts

### 1. Schema-Driven Development

- Define your backend using a `.keel` schema file
- Schema defines models, actions, permissions, and APIs
- Automatic code generation and type safety

### 2. APIs

Keel generates three API types:

- **GraphQL API** (`/api/graphql`) - Query exact data needs, cross-relational queries
- **JSON API** (`/api/json/<actionName>`) - REST-like, OpenAPI v3.1 compliant
- **JSON-RPC API** (`/api/rpc`) - Lightweight RPC protocol (JSON-RPC 2.0)

### 3. Authentication

- JWT-based authentication across all API types
- Access token required in `Authorization` header
- Built-in identity management

---

## Models

Models define your data structure and are written in UpperCamelCase.

### Built-in Fields

Every model automatically includes:

- `id` - Unique identifier
- `createdAt` - Creation timestamp
- `updatedAt` - Last update timestamp

### Field Types

- `Text` - String data
- `Markdown` - Markdown-formatted text
- `Number` - Integer values
- `Decimal` - Decimal numbers
- `Boolean` - True/false
- `Timestamp` - Date and time
- `Date` - Date only
- `Duration` - Time duration
- `ID` - Reference to another model
- `File` - File upload
- Arrays using `[]` notation

### Field Modifiers

- `?` - Optional field
- `@default` - Set default value
- `@unique` - Ensure uniqueness
- `@computed` - Auto-generated value
- `@sequence` - Auto-incrementing identifier

### Example Model

```
model Product {
  fields {
    title Text
    description Text?
    price Decimal
    onSale Boolean @default(false)
    sku Text @unique
    category Category
    tags Text[]
  }
}

enum Category {
  Electronics
  Clothing
  Books
}
```

### Relationships

- **One-to-Many**: Reference model with optional array
- **Many-to-Many**: Use intermediary join model
- **One-to-One**: Use `@unique` with optional `?`
- `@relation` - Define multiple relationships between same models

---

## Actions

Actions define how models behave. Named in lowerCamelCase and must be unique across the app.

### Built-in Action Types

#### `get` - Retrieve Single Record

```
get getProduct(id)
```

- Retrieves one record by unique field
- Can use any unique field for lookup

#### `list` - Retrieve Multiple Records

```
list listProducts(category?, onSale?)
@orderBy(createdAt: desc)
@sortable(price)
```

- Supports filtering with optional inputs
- `@orderBy` - Server-side default ordering
- `@sortable` - Allow client-side sorting

#### `create` - Create New Record

```
create createProduct() with (title, description, price, category) {
  @set(product.onSale = false)
}
```

- `with` clause defines writable fields
- `@set` for additional field values
- Can create nested records

#### `update` - Modify Existing Record

```
update updateProduct(id) with (title?, price?) {
  @set(product.updatedAt = ctx.now)
}
```

- Read inputs identify the record
- Write inputs (after `with`) specify changes
- Optional write inputs

#### `delete` - Remove Record

```
delete deleteProduct(id)
```

- Removes record and returns deleted ID

### Action Modifiers

- `@where` - Additional filtering conditions
- `@embed` - Include related data in responses
- `@permission` - Define access control

---

## Permissions

**Default**: All actions denied unless explicitly permitted (secure by default)

### Permission Types

#### Role-Based Permissions

```
@permission(roles: [Staff, Admin], actions: [update, delete])
```

#### Row-Based Permissions (Expression-Based)

```
@permission(
  expression: post.author.identity == ctx.identity,
  actions: [update, delete]
)
```

#### Public Access

```
@permission(expression: true, actions: [get, list])
```

### Permission Features

- Applied at model or action level
- Can traverse relationships
- Multiple rules allowed (first passing rule grants access)
- Integrates with identity system

### Permission Context

- `ctx.identity` - Current authenticated user
- Compare against database fields
- Use enum values
- Check roles

---

## Functions

Custom TypeScript functions in the `functions` directory.

### Function Types

1. **Action Hooks** - Modify default action behavior
2. **Auth Hooks** - Customize authentication flows
3. **Custom Functions** - Standalone functions with custom I/O

### Function Structure

```typescript
export default FunctionName(async (ctx, inputs) => {
  // Access context
  const apiKey = ctx.secrets.API_TOKEN;
  const userId = ctx.identity?.id;

  // Database operations
  const product = await models.product.findOne({ id: inputs.id });

  // Return data
  return {
    success: true,
    data: product,
  };
});
```

### Context Object

- `ctx.secrets` - Access secrets
- `ctx.env` - Environment variables
- `ctx.identity` - Current user identity
- `ctx.now` - Current timestamp

### Database Interaction

- Type-safe Model API (`@teamkeel/sdk`)
- Low-level Database API for complex queries
- Automatic transaction support for mutations

### Transactions

- Enabled by default for mutation hooks and `write` functions
- Configure with `autoTransaction` property

---

## Schema File Structure

Typical `.keel` schema organization:

```
// Models
model User { ... }
model Product { ... }

// Enums
enum Role { ... }

// Actions
api Web {
  // Public actions
  @permission(expression: true)
  models {
    Product {
      get getProduct(id)
      list listProducts(category?)
    }
  }

  // Protected actions
  @permission(expression: ctx.isAuthenticated)
  models {
    Order {
      create createOrder(...)
    }
  }
}

// Jobs (scheduled tasks)
job ProcessOrders {
  @schedule("0 0 * * *")
}
```

---

## Best Practices

1. **Naming Conventions**

   - Models: UpperCamelCase (e.g., `ProductCategory`)
   - Actions: lowerCamelCase (e.g., `listProducts`)
   - Fields: lowerCamelCase (e.g., `createdAt`)

2. **Permissions**

   - Always define explicit permissions
   - Start with most restrictive, open up as needed
   - Use row-based permissions for user-specific data

3. **Actions**

   - Keep action names descriptive and unique
   - Use optional inputs for flexible filtering
   - Leverage `@embed` to reduce API calls

4. **Functions**

   - One function per file matching schema name
   - Use Model API for simple queries
   - Reserve Database API for complex operations

5. **Relationships**
   - Define relationships bidirectionally when needed
   - Use join models for many-to-many
   - Consider `@relation` name for multiple relationships

---

## CLI Usage

Generate TypeScript clients:

```bash
keel client
```

This generates fully-typed clients with:

- Autocompletion
- Type safety
- API method stubs

---

## Common Patterns

### User-Owned Resources

```
model Post {
  fields {
    title Text
    author User
  }

  @permission(
    expression: post.author.identity == ctx.identity,
    actions: [update, delete]
  )
}
```

### Soft Deletes

```
model Product {
  fields {
    deletedAt Timestamp?
  }
}

list activeProducts() {
  @where(product.deletedAt == null)
}
```

### Audit Trail

```
model AuditLog {
  fields {
    action Text
    user User
    recordId Text
    changes JSON?
  }
}
```

---

## Resources

- **Documentation**: https://docs.keel.so/
- **Quickstart**: https://docs.keel.so/quickstart
- **Discord Community**: Available via docs
- **Support**: help@keel.so
- **GitHub**: Public repository available

---

## Key Takeaways

- Schema defines everything: models, actions, permissions
- Automatic API generation (GraphQL, JSON, JSON-RPC)
- Secure by default with explicit permissions
- TypeScript functions for custom logic
- Type-safe client generation
- Built for rapid development and scalability
