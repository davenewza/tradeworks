<template>
  <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-hidden">
      <!-- Header -->
      <div class="flex justify-between items-center p-6 border-b border-gray-200">
        <h3 class="text-lg font-medium text-gray-900">Add Product to Quote</h3>
        <button @click="$emit('close')" class="text-gray-400 hover:text-gray-600">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="p-6 overflow-y-auto max-h-[calc(90vh-140px)]">
        <!-- Search -->
        <div class="mb-6">
          <label class="block text-sm font-medium text-gray-700 mb-2">Search Products</label>
          <input 
            v-model="searchQuery" 
            type="text" 
            placeholder="Search by name or SKU..."
            class="input"
            @input="searchProducts"
          />
        </div>

        <!-- Loading State -->
        <div v-if="loading" class="flex justify-center items-center py-8">
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>

        <!-- Products List -->
        <div v-else-if="filteredProductPrices.length === 0" class="text-center py-8">
          <div class="text-gray-500 mb-4">
            <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"></path>
            </svg>
          </div>
          <h4 class="text-lg font-medium text-gray-900 mb-2">No products found</h4>
          <p class="text-gray-600">Try adjusting your search terms.</p>
        </div>

        <div v-else class="space-y-4">
          <div 
            v-for="productPrice in filteredProductPrices" 
            :key="productPrice.id" 
            class="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 cursor-pointer"
            @click="selectProduct(productPrice)"
          >
            <div class="flex items-center space-x-4">
              <div class="flex-1">
                <h4 class="font-medium text-gray-900">{{ productPrice.productName }}</h4>
                <p class="text-sm text-gray-600">SKU: {{ productPrice.productSku }}</p>
                <div class="flex items-center space-x-4 mt-2">
                  <div>
                    <span class="text-sm font-medium text-gray-900">ZAR {{ formatCurrency(productPrice.price) }}</span>
                  </div>
                  <div>
                    <span class="text-xs text-gray-500">
                      incl. VAT: ZAR {{ formatCurrency(productPrice.priceInclVat) }}
                    </span>
                  </div>
                </div>
              </div>
              <div class="text-right">
                <button class="btn btn-primary text-sm">
                  Add to Quote
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="flex justify-end space-x-3 p-6 border-t border-gray-200">
        <button @click="$emit('close')" class="btn btn-secondary">Cancel</button>
      </div>
    </div>
  </div>
</template>

<script>
import { productService } from '../services/productService.js'
import { quoteService } from '../services/quoteService.js'

export default {
  name: 'AddProductModal',
  props: {
    quoteId: {
      type: String,
      required: true
    },
    priceListId: {
      type: String,
      required: false,
      default: ''
    },
    existingQuoteProducts: {
      type: Array,
      default: () => []
    }
  },
  data() {
    return {
      productPrices: [],
      filteredProductPrices: [],
      searchQuery: '',
      loading: false
    }
  },
  async mounted() {
    await this.loadProductPrices()
  },
  methods: {
    async loadProductPrices() {
      this.loading = true
      try {
        let priceListId = this.priceListId
        if (!priceListId) {
          // Try to infer from quoteId → fetch quote to get CPL id, then resolve its priceListId
          const quote = await quoteService.getQuote(this.quoteId)
          const { priceListService } = await import('../services/priceListService.js')
          // Load CPL to get its priceListId
          const cpls = await priceListService.getCustomerPriceLists(quote.customerPriceList?.customer?.id || '')
          const match = cpls.find(cpl => cpl.id === quote.customerPriceListId)
          priceListId = match?.priceListId || ''
        }
        this.productPrices = priceListId ? await productService.getProductPricesByPriceList(priceListId) : []
        this.filteredProductPrices = this.filterAvailableProducts(this.productPrices)
      } catch (err) {
        console.error('Failed to load product prices:', err)
      } finally {
        this.loading = false
      }
    },
    
    filterAvailableProducts(productPrices) {
      // Get the product price IDs that are already in the quote
      const existingProductPriceIds = this.existingQuoteProducts.map(qp => qp.productPriceId)
      
      // Filter out products that are already in the quote
      return productPrices.filter(productPrice => 
        !existingProductPriceIds.includes(productPrice.id)
      )
    },
    
    searchProducts() {
      const availableProducts = this.filterAvailableProducts(this.productPrices)
      
      if (!this.searchQuery.trim()) {
        this.filteredProductPrices = availableProducts
        return
      }
      
      const query = this.searchQuery.toLowerCase()
      this.filteredProductPrices = availableProducts.filter(productPrice => 
        productPrice.productName.toLowerCase().includes(query) ||
        productPrice.productSku.toLowerCase().includes(query)
      )
    },
    
    async selectProduct(productPrice) {
      try {
        // Default quantity to 1
        const quantity = 1
        
        await quoteService.addProductToQuote(this.quoteId, productPrice.id, quantity)
        this.$emit('product-added')
      } catch (err) {
        console.error('Failed to add product to quote:', err)
        alert('Failed to add product to quote')
      }
    },
    

    
    formatCurrency(amount) {
      if (!amount) return '0.00'
      return parseFloat(amount).toLocaleString('en-ZA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    }
  }
}
</script>
