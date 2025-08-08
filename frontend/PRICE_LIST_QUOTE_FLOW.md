# Price List and Quote Display Flow

## Overview

The TradeWorks application automatically displays price lists and quotes for users based on their customer assignment retrieved from the user profile endpoints.

## Current Implementation Status

✅ **FULLY IMPLEMENTED** - The system is working correctly and displays price lists and quotes using the customerId from user endpoints.

## Authentication and Customer ID Flow

### 1. User Login Process
```
User Login → Authentication → User Profile Retrieval → Customer ID Extraction → Price List Display
```

### 2. Detailed Flow

#### **Step 1: Authentication**
- User enters email/password
- System calls `POST /auth/token`
- Receives access token and `identity_created` flag

#### **Step 2: User Profile Retrieval**
- **New Users**: Profile completion dialog → `createMe` with firstName/lastName
- **Existing Users**: Direct call to `getMe` endpoint
- **Fallback**: If `getMe` returns null, call `createMe`

#### **Step 3: Customer ID Extraction**
```javascript
// In authService.js
getCustomerId(user) {
  return user?.customer?.id || null
}
```

#### **Step 4: Price List Manager Rendering**
```vue
<!-- In App.vue -->
<PriceListManager v-else-if="customerId" :customer-id="customerId" />
```

## Price List and Quote Loading

### **PriceListManager Component**

#### **Props**
- `customerId` (required): Retrieved from user profile

#### **Data Loading Process**
1. **Customer Price Lists**: `priceListService.getCustomerPriceLists(customerId)`
2. **Price List Details**: `priceListService.getPriceList(priceListId)` for each
3. **Quotes**: `quoteService.getQuotesByCustomerPriceList(customerPriceListId)` for each

#### **Display Content**
- **Price Lists**: Shows all assigned price lists with names and creation dates
- **Quotes**: Shows quotes for each price list
- **Actions**: View price list, create quote, view quote details

## API Endpoints Used

### **Authentication**
- `POST /auth/token` - User authentication

### **User Profile**
- `POST /api/json/getMe` - Retrieve user profile
- `POST /api/json/createMe` - Create user (with/without profile)

### **Price Lists**
- `GET /api/json/listCustomerPriceLists` - Get customer's price lists
- `GET /api/json/getPriceList` - Get price list details

### **Quotes**
- `GET /api/json/listQuotes` - Get quotes by customer price list

## User Experience

### **For Users with Customer Assignment**
1. **Login** with credentials
2. **Automatic Loading** of price lists and quotes
3. **View Price Lists** with creation dates and product counts
4. **View Quotes** for each price list
5. **Create New Quotes** from price lists
6. **View Quote Details** with products and totals

### **For Users without Customer Assignment**
1. **Login** with credentials
2. **"No Customer Assigned"** message displayed
3. **Contact Administrator** instruction shown

## Component Structure

```
App.vue
├── LoginForm (if not authenticated)
├── UserProfileDialog (if new user)
└── PriceListManager (if authenticated and has customerId)
    ├── Price Lists Display
    ├── Quotes Display
    ├── QuoteDetail (when quote selected)
    └── PriceListView (when price list selected)
```

## Data Flow

### **Customer ID Retrieval**
```
User Login → getMe/createMe → user.customer.id → PriceListManager
```

### **Price List Loading**
```
customerId → getCustomerPriceLists → getPriceList → Display Price Lists
```

### **Quote Loading**
```
customerPriceListId → getQuotesByCustomerPriceList → Display Quotes
```

## Error Handling

### **Authentication Errors**
- Invalid credentials → Error message in login form
- Token expiration → Automatic refresh or logout

### **Profile Errors**
- getMe returns null → Fallback to createMe
- Profile creation fails → Error message and logout

### **Data Loading Errors**
- No customer assignment → "No Customer Assigned" message
- API failures → Error messages with retry options
- Timeout protection → 10-second loading timeout

## Testing Verification

### **Expected Behavior**
1. **Login Success**: User sees price lists and quotes
2. **No Customer**: User sees "No Customer Assigned" message
3. **New User**: Profile completion → Price lists display
4. **Existing User**: Direct to price lists display

### **Console Logging**
- Customer ID extraction
- Price list loading
- Quote loading
- Error handling

## Security Features

✅ **Authentication Required**: Must be logged in to access data
✅ **Customer Isolation**: Users only see their assigned customer data
✅ **Token Management**: Secure token storage and refresh
✅ **Backend Control**: Customer assignment managed in database

## Performance Optimizations

✅ **Caching**: User profile cached in localStorage
✅ **Lazy Loading**: Services imported dynamically
✅ **Error Recovery**: Graceful handling of API failures
✅ **Loading States**: User feedback during data loading

The system is fully functional and provides a seamless experience for users to view their assigned price lists and quotes based on their customer profile.
