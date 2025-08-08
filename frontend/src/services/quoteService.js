import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class QuoteService {
  async makeRequest(endpoint, data = null) {
    const headers = {
      'Content-Type': 'application/json',
    }
    
    // Add authentication header if available
    const token = authService.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(errorData.message || `HTTP error! status: ${response.status}`)
    }

    return response.json()
  }

  // Get quotes for a specific customer
  async getQuotesByCustomer(customerId) {
    const response = await this.makeRequest('/listQuotes', {
      where: {
        customerPriceList: {
          customer: {
            id: {
              equals: customerId
            }
          }
        }
      }
    })
    return response.results || []
  }

  // Get quotes for a specific customer price list
  async getQuotesByCustomerPriceList(customerPriceListId) {
    const response = await this.makeRequest('/listQuotes', {
      where: {
        customerPriceList: {
          id: {
            equals: customerPriceListId
          }
        }
      }
    })
    return response.results || []
  }

  // Get a specific quote
  async getQuote(quoteId) {
    return await this.makeRequest('/getQuote', { id: quoteId })
  }

  // Create a new quote
  async createQuote(customerPriceListId) {
    return await this.makeRequest('/createQuote', {
      customerPriceList: {
        id: customerPriceListId
      }
    })
  }

  // Delete a quote
  async deleteQuote(quoteId) {
    return await this.makeRequest('/deleteQuote', { id: quoteId })
  }

  // Get products for a specific quote
  async getQuoteProducts(quoteId) {
    const response = await this.makeRequest('/listQuoteProducts', {
      where: {
        quote: {
          id: {
            equals: quoteId
          }
        }
      }
    })
    return response.results || []
  }

  // Add a product to a quote
  async addProductToQuote(quoteId, productPriceId, quantity) {
    return await this.makeRequest('/createQuoteProduct', {
      quote: {
        id: quoteId
      },
      productPrice: {
        id: productPriceId
      },
      quantity: quantity
    })
  }

  // Update a quote product quantity
  async updateQuoteProduct(productId, quantity) {
    return await this.makeRequest('/updateQuoteProduct', {
      where: {
        id: productId
      },
      values: {
        quantity: quantity
      }
    })
  }

  // Delete a quote product
  async deleteQuoteProduct(productId) {
    return await this.makeRequest('/deleteQuoteProduct', { id: productId })
  }
}

export const quoteService = new QuoteService()
