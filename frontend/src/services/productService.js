import { API_BASE } from '../config/api.js'
import { authService } from './authService.js'

class ProductService {
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

  // Get all products
  async getProducts() {
    const response = await this.makeRequest('/listProducts', {})
    return response.results || []
  }

  // Get a specific product
  async getProduct(productId) {
    return await this.makeRequest('/getProduct', { id: productId })
  }


  // Get product prices by price list
  async getProductPricesByPriceList(priceListId) {
    const response = await this.makeRequest('/listProductPrices', {
      where: {
        priceList: {
          id: {
            equals: priceListId
          }
        }
      }
    })
    return response.results || []
  }
}

export const productService = new ProductService()
