# TradeWorks Quote Management System

A modern Vue.js single-page application for managing customer quotes with a clean, responsive interface built with Tailwind CSS.

## Features

- **Authentication**: Secure login/logout with password reset functionality
- **Quote Management**: View, create, update, and delete quotes
- **Product Management**: Add, update, and remove products from quotes
- **Real-time Calculations**: Automatic calculation of totals including VAT
- **Modern UI**: Clean, responsive design with Tailwind CSS
- **Search Functionality**: Search products by name or SKU
- **Customer-specific**: Filter quotes by customer ID

## Prerequisites

- Node.js (v16 or higher)
- Backend API running on `http://localhost:8000`
- Valid user account with customer assignment

## Environment Variables

The application uses the following environment variable:

- `VITE_API_URL`: The URL of the backend API (defaults to `http://localhost:8000` for local development)

### Local Development
For local development, you can either:
1. Use the default `http://localhost:8000` (no configuration needed)
2. Create a `.env` file with your custom API URL:
   ```
   VITE_API_URL=http://localhost:8000
   ```

### Production Deployment (Vercel)
For production deployment, you must set the `VITE_API_URL` environment variable in your Vercel project settings:

1. Go to your Vercel project dashboard
2. Navigate to Settings → Environment Variables
3. Add a new variable:
   - **Name**: `VITE_API_URL`
   - **Value**: Your production API URL (e.g., `https://your-backend-domain.com`)
   - **Environment**: Production (and Preview if needed)

**Important**: The environment variable must be set before building the application, as Vite replaces these values at build time.

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
http://localhost:3000
```

## Usage

### Authentication

The application now includes authentication. Users must log in before accessing the system:

1. **Login**: Enter your email and password on the login screen
2. **Password Reset**: Use the "Forgot Password" link to reset your password
3. **Logout**: Click the logout button in the top-right corner

### Accessing the Application

The application automatically retrieves the customer ID from your user profile via the authentication system. Simply log in with your credentials, and the system will:

1. **Authenticate** your account
2. **Retrieve your profile** including customer assignment
3. **Display your data** or show a message if no customer is assigned

**Note**: The application no longer uses URL query parameters for customer identification.

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

### Authentication Configuration

For proper authentication setup, see [AUTHENTICATION.md](./AUTHENTICATION.md) for detailed instructions on configuring Keel authentication.

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
- **Keel**: Backend API with authentication support
- **Tailwind CSS**: Utility-first CSS framework
- **Fetch API**: Modern HTTP client for API calls

## Browser Support

The application supports all modern browsers that support:
- ES6+ JavaScript features
- CSS Grid and Flexbox
- Fetch API
