# Page Refresh Behavior

This document explains how the application handles page refreshes and ensures users always return to the main price lists and quotes view with fresh data.

## Overview

When a user refreshes the page while logged in, the application ensures:

1. **Fresh Authentication**: User data is re-fetched from the API
2. **Clean State**: Always returns to the main price lists view (not quote details or price list view)
3. **Fresh Data**: All price lists and quotes are re-fetched from the API
4. **Consistent Experience**: Users always see the most up-to-date information

## Implementation Details

### 1. App.vue - Authentication Refresh

**Location**: `src/App.vue`

**Behavior**: On page refresh, the app always re-fetches user data instead of relying on cached data.

```javascript
async mounted() {
  this.isAuthenticated = authService.isAuthenticated()
  
  if (this.isAuthenticated) {
    // Always refetch user data on page refresh
    try {
      this.currentUser = await authService.getCurrentUser()
      this.customerId = authService.getCustomerId(this.currentUser)
    } catch (error) {
      // Fallback to cached data if fresh fetch fails
      this.currentUser = await authService.getCurrentUserCached()
      this.customerId = authService.getCustomerId(this.currentUser)
    }
  }
}
```

### 2. PriceListManager - Component Reset

**Location**: `src/components/PriceListManager.vue`

**Behavior**: The component is forced to re-render and reset its state on every mount.

```javascript
// App.vue - Forces component re-render
<PriceListManager 
  v-else-if="hasCustomerId" 
  :customer-id="customerId" 
  :key="`price-list-manager-${customerId}`"
/>

// PriceListManager.vue - Resets state on mount
async mounted() {
  // Reset state to ensure we always start with the main view
  this.selectedQuote = null
  this.selectedPriceList = null
  this.loading = true
  this.error = null
  this.priceLists = []
  this.quotes = {}
  
  // Load fresh data
  await this.loadCustomerPriceLists()
}
```

### 3. Data Refresh Mechanisms

#### A. Component Key Prop
- **Purpose**: Forces Vue to completely re-create the component when customerId changes
- **Effect**: Ensures clean state and fresh data loading

#### B. Customer ID Watcher
- **Purpose**: Responds to customerId prop changes
- **Effect**: Automatically reloads data when customer assignment changes

```javascript
watch: {
  customerId: {
    immediate: true,
    async handler(newCustomerId, oldCustomerId) {
      if (newCustomerId && newCustomerId !== oldCustomerId) {
        // Reset state and reload data
        this.selectedQuote = null
        this.selectedPriceList = null
        await this.loadCustomerPriceLists()
      }
    }
  }
}
```

#### C. Page Visibility API
- **Purpose**: Refreshes data when user returns to the tab after being away
- **Effect**: Ensures data is fresh when user switches back to the application

```javascript
handleVisibilityChange() {
  if (!document.hidden && this.lastHiddenTime && (Date.now() - this.lastHiddenTime > 30000)) {
    this.refreshData()
  }
  this.lastHiddenTime = document.hidden ? Date.now() : null
}
```

## User Experience Flow

### Page Refresh Scenario

1. **User refreshes page** while viewing a quote detail
2. **App.vue** detects authentication and re-fetches user data
3. **PriceListManager** is re-created with a new key
4. **Component state is reset** (no selected quote or price list)
5. **Fresh data is loaded** from the API
6. **User sees main price lists view** with updated information

### Tab Switch Scenario

1. **User switches to another tab** for 30+ seconds
2. **User returns to the application tab**
3. **Page visibility change is detected**
4. **Data is automatically refreshed**
5. **User sees updated information**

## Benefits

### ✅ Consistent State
- Users always start from the main view after refresh
- No unexpected navigation states
- Clean, predictable experience

### ✅ Fresh Data
- Always shows the most recent information
- No stale data from previous sessions
- Real-time updates when returning to the app

### ✅ Reliable Authentication
- Re-validates user session on every page load
- Handles token expiration gracefully
- Falls back to cached data if needed

### ✅ Performance Optimized
- Only refreshes data when necessary
- Uses cached data as fallback
- Efficient API calls with proper error handling

## Testing

### Manual Testing Scenarios

1. **Refresh during quote detail view**
   - Expected: Return to main price lists view
   - Expected: Fresh data loaded

2. **Refresh during price list view**
   - Expected: Return to main price lists view
   - Expected: Fresh data loaded

3. **Switch tabs and return**
   - Expected: Data refreshed after 30 seconds
   - Expected: No refresh for short tab switches

4. **Network interruption during refresh**
   - Expected: Fallback to cached data
   - Expected: Error handling with retry options

### Console Logs

The application provides detailed console logs for debugging:

```
User data refreshed on page load: {user object}
Customer ID refreshed on page load: customer-id
PriceListManager mounted - loading fresh data for customer: customer-id
Customer ID changed, reloading data: customer-id
User returned to tab after being away, refreshing data
Refreshing all data...
```

## Configuration

### Timeout Settings

- **Loading timeout**: 10 seconds
- **Tab switch refresh delay**: 30 seconds
- **API request timeout**: Handled by fetch API

### Environment Variables

No additional environment variables are required for this functionality. The behavior works with the existing `VITE_API_URL` configuration.
