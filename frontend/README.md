# TradeWorks Quote Management System

A modern Vue.js single-page application for managing customer quotes with a clean, responsive interface built with Tailwind CSS.

## Features

- **Quote Management**: View, create, update, and delete quotes
- **Product Management**: Add, update, and remove products from quotes
- **Real-time Calculations**: Automatic calculation of totals including VAT
- **Modern UI**: Clean, responsive design with Tailwind CSS
- **Search Functionality**: Search products by name or SKU
- **Customer-specific**: Filter quotes by customer ID

## Prerequisites

- Node.js (v16 or higher)
- Backend API running on `http://localhost:8000`

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

3. Open your browser and navigate to:
```
http://localhost:3000?customerId=YOUR_CUSTOMER_ID
```

## Usage

### Accessing the Application

The application requires a `customerId` query parameter in the URL. For example:
```
http://localhost:3000?customerId=cust_123456
```

### Managing Quotes

1. **View Quotes**: The main page displays all quotes for the specified customer
2. **Create Quote**: Click "New Quote" to create a new quote
3. **Edit Quote**: Click on any quote to view and edit its details
4. **Delete Quote**: Use the delete button in the quote detail view

### Managing Products in Quotes

1. **Add Products**: Click "Add Product" in the quote detail view
2. **Update Quantities**: Modify quantities directly in the product list
3. **Remove Products**: Use the remove button next to each product

## API Integration

The application integrates with the TradeWorks backend API and supports:

- Quote CRUD operations
- Product management within quotes
- Real-time price calculations
- Customer-specific data filtering

## Development

### Project Structure

```
src/
├── components/
│   ├── QuoteManager.vue      # Main quote management component
│   ├── QuoteDetail.vue       # Individual quote detail view
│   └── AddProductModal.vue   # Modal for adding products
├── services/
│   ├── quoteService.js       # Quote-related API calls
│   └── productService.js     # Product-related API calls
├── App.vue                   # Main application component
├── main.js                   # Application entry point
└── style.css                 # Global styles with Tailwind
```

### Building for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Technologies Used

- **Vue.js 3**: Progressive JavaScript framework
- **Vite**: Fast build tool and development server
- **Tailwind CSS**: Utility-first CSS framework
- **Fetch API**: Modern HTTP client for API calls

## Browser Support

The application supports all modern browsers that support:
- ES6+ JavaScript features
- CSS Grid and Flexbox
- Fetch API
