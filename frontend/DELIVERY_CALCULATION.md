# Delivery Calculation Feature

This document explains the implementation of the delivery calculation feature that integrates with the Shiplogic API to provide shipping rates for quotes.

## Overview

The delivery calculation feature allows users to:
1. Calculate equipment boxes for a quote
2. Get real-time shipping rates from Shiplogic API
3. View available delivery options with pricing and delivery dates
4. Make informed decisions about shipping costs

## Backend Implementation

### CalculateDelivery Function

**Location**: `backend/functions/calculateDelivery.ts`

**Purpose**: Retrieves equipment boxes from a quote and calculates shipping rates using the Shiplogic API.

**Process**:
1. **Quote Validation**: Verifies the quote exists
2. **Equipment Box Retrieval**: Gets all equipment boxes associated with the quote
3. **Parcel Conversion**: Converts equipment boxes to parcels for the API
4. **API Call**: Sends request to Shiplogic API with parcel details
5. **Rate Processing**: Sorts and formats available shipping rates
6. **Response**: Returns structured delivery options

**API Configuration**:
```typescript
const SHIPLOGIC_API_URL = 'https://api.shiplogic.com/v2/rates?provider_id=123'
const SHIPLOGIC_API_KEY = '9480346aa35d4aec9ba1c067990e4503'
```

**Address Configuration**:
- **Collection Address**: CREATESPACE, Somerset West, Western Cape
- **Delivery Address**: Default residential address in Pretoria, Gauteng

### Data Flow

1. **Equipment Box → Parcel Conversion**:
   ```typescript
   parcels.push({
     submitted_length_cm: Number(equipmentBox.lengthInCm),
     submitted_width_cm: Number(equipmentBox.widthInCm),
     submitted_height_cm: Number(equipmentBox.heightInCm),
     submitted_weight_kg: Number(equipmentBox.weightInGrams) / 1000
   })
   ```

2. **API Request Structure**:
   ```json
   {
     "collection_address": { /* CREATESPACE address */ },
     "delivery_address": { /* Customer address */ },
     "parcels": [ /* Array of equipment box parcels */ ]
   }
   ```

3. **Response Processing**:
   - Sorts rates by price (lowest first)
   - Calculates total weight and volume
   - Formats service level information
   - Returns structured delivery options

## Frontend Implementation

### Delivery Service

**Location**: `frontend/src/services/deliveryService.js`

**Purpose**: Provides a clean interface to call the backend delivery calculation function.

**Methods**:
- `calculateDelivery(quoteId)`: Calls the backend function and returns delivery rates

### QuoteDetail Component Integration

**Location**: `frontend/src/components/QuoteDetail.vue`

**Features Added**:
1. **Calculate Delivery Rates Button**: Only enabled when equipment boxes are calculated
2. **Delivery Rates Display**: Shows available shipping options with pricing
3. **Error Handling**: Displays user-friendly error messages
4. **Loading States**: Shows loading spinner during API calls

**UI Elements**:
- **Button**: "Calculate Delivery Rates" with loading state
- **Rate Cards**: Individual cards for each shipping option
- **Service Details**: Delivery dates, collection times, weight information
- **Pricing**: ZAR currency display with VAT breakdown

## User Experience Flow

### Prerequisites
1. **Quote Created**: User must have an active quote
2. **Products Added**: Quote must contain products
3. **Equipment Boxes Calculated**: Must calculate equipment boxes first

### Delivery Rate Calculation
1. **User clicks "Calculate Delivery Rates"** in Shipping Details section
2. **System validates prerequisites** (equipment boxes must exist)
3. **Backend processes equipment boxes** and converts to parcels
4. **Shiplogic API call** with parcel and address information
5. **Rates displayed** in organized cards with pricing and delivery information

### Displayed Information
- **Service Level**: Economy, Overnight, etc.
- **Description**: Delivery time expectations
- **Delivery Dates**: Expected delivery window
- **Collection Information**: Pickup date and cut-off time
- **Weight Details**: Actual vs. charged weight
- **Pricing**: Total cost with VAT breakdown

## API Integration Details

### Shiplogic API Endpoint
- **URL**: `https://api.shiplogic.com/v2/rates?provider_id=123`
- **Method**: POST
- **Authentication**: Bearer token
- **Content-Type**: application/json

### Request Format
```json
{
  "collection_address": {
    "type": "business",
    "company": "CREATESPACE",
    "street_address": "65 Oak Street",
    "local_area": "Somerset West",
    "city": "Somerset West",
    "zone": "Western Cape",
    "country": "ZA",
    "code": "7130"
  },
  "delivery_address": {
    "type": "residential",
    "company": "",
    "street_address": "10 Midas Avenue",
    "local_area": "Olympus AH",
    "city": "Pretoria",
    "zone": "Gauteng",
    "country": "ZA",
    "code": "0081"
  },
  "parcels": [
    {
      "submitted_length_cm": 89,
      "submitted_width_cm": 59,
      "submitted_height_cm": 44,
      "submitted_weight_kg": 30
    }
  ]
}
```

### Response Processing
The system processes the API response to extract:
- **Service Levels**: Different shipping options (Economy, Overnight)
- **Pricing**: Rates with and without VAT
- **Delivery Information**: Dates and collection times
- **Weight Information**: Actual and volumetric weights

## Error Handling

### Backend Errors
- **Quote not found**: Invalid quote ID
- **No equipment boxes**: Equipment boxes must be calculated first
- **API errors**: Network issues or invalid API responses
- **Invalid data**: Missing equipment box dimensions or weights

### Frontend Errors
- **Prerequisites not met**: Equipment boxes not calculated
- **API failures**: Network or server errors
- **Data validation**: Invalid response format

### User Feedback
- **Loading states**: Spinner during API calls
- **Error messages**: Clear explanation of issues
- **Success feedback**: Organized display of available rates

## Configuration

### Environment Variables
- **API Key**: Shiplogic authentication token
- **API URL**: Shiplogic endpoint
- **Provider ID**: Shiplogic provider identifier

### Address Configuration
Currently hardcoded but could be made configurable:
- **Collection Address**: CREATESPACE warehouse location
- **Delivery Address**: Default customer address

## Future Enhancements

### Potential Improvements
1. **Dynamic Addresses**: Allow customer address input
2. **Multiple Providers**: Support for different courier companies
3. **Rate Comparison**: Side-by-side comparison of different services
4. **Booking Integration**: Direct booking of selected shipping option
5. **Tracking Integration**: Track shipped packages
6. **Address Validation**: Validate customer addresses before calculation

### Configuration Options
1. **Address Management**: Customer address database
2. **Provider Selection**: Choose preferred courier companies
3. **Rate Preferences**: Default to specific service levels
4. **Weight Limits**: Set maximum package weights
5. **Delivery Zones**: Configure delivery area restrictions

## Testing

### Manual Testing Scenarios
1. **Valid Quote with Equipment Boxes**: Should return delivery rates
2. **Quote without Equipment Boxes**: Should show error message
3. **API Failure**: Should handle network errors gracefully
4. **Invalid Quote ID**: Should show appropriate error
5. **Multiple Equipment Boxes**: Should calculate combined shipping

### API Testing
1. **Valid Request**: Proper parcel and address data
2. **Rate Sorting**: Rates displayed in price order
3. **Date Formatting**: Delivery dates properly formatted
4. **Currency Display**: ZAR currency with proper formatting
5. **Error Responses**: API error handling

## Security Considerations

### API Security
- **Authentication**: Bearer token authentication
- **HTTPS**: Secure API communication
- **Rate Limiting**: Respect API rate limits
- **Error Handling**: Don't expose sensitive information in errors

### Data Protection
- **Address Privacy**: Handle customer addresses securely
- **API Key Protection**: Secure storage of authentication tokens
- **Input Validation**: Validate all input data
- **Error Logging**: Log errors without exposing sensitive data
