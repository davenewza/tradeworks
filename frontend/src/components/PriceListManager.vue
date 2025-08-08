<template>
  <div>
    <!-- Loading State -->
    <div v-if="loading" class="flex justify-center items-center py-12">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="card">
      <div class="text-center">
        <div class="text-red-600 text-lg font-medium mb-2">Error</div>
        <p class="text-gray-600 mb-4">{{ error }}</p>
        <button @click="loadCustomerPriceLists" class="btn btn-primary">Try Again</button>
      </div>
    </div>

    <!-- Quote Detail View -->
    <div v-else-if="selectedQuote">
      <QuoteDetail 
        :quote="selectedQuote" 
        @back="selectedQuote = null"
        @quote-updated="handleQuoteUpdated"
        @quote-deleted="handleQuoteDeleted"
      />
    </div>

    <!-- Price List View -->
    <div v-else-if="selectedPriceList">
      <PriceListView 
        :price-list="selectedPriceList"
        @close="selectedPriceList = null"
      />
    </div>

    <!-- Main Content -->
    <div v-else>
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-2xl font-semibold text-gray-900">Your Price Lists</h2>
      </div>

      <!-- Price Lists -->
      <div v-if="priceLists.length === 0" class="card text-center py-12">
        <div class="text-gray-500 mb-4">
          <svg class="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
          </svg>
        </div>
        <h3 class="text-lg font-medium text-gray-900 mb-2">No price lists assigned</h3>
        <p class="text-gray-600 mb-4">You don't have any price lists assigned to your account.</p>
      </div>

      <div v-else class="space-y-8">
        <div 
          v-for="priceList in priceLists" 
          :key="priceList.id" 
          class="card"
        >
          <div class="flex justify-between items-start mb-6">
            <div>
              <h3 class="text-xl font-semibold text-gray-900 mb-1">{{ priceList.name }}</h3>
              <p class="text-sm text-gray-600">
                Created: {{ formatDate(priceList.createdAt) }}
              </p>
            </div>
            <div class="flex space-x-2">
              <button 
                @click="viewPriceList(priceList)"
                class="btn btn-secondary text-sm"
                title="View Price List"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                </svg>
              </button>
              <button 
                @click="createQuoteFromPriceList(priceList)"
                class="btn btn-primary text-sm"
                title="Create Quote"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                </svg>
              </button>
            </div>
          </div>
          
          <!-- Quotes Section -->
          <div class="border-t pt-4">
            <div class="flex justify-between items-center mb-4">
              <h4 class="text-lg font-medium text-gray-900">Quotes</h4>
              <span class="text-sm text-gray-600">{{ quotes[priceList.customerPriceListId]?.length || 0 }} quotes</span>
            </div>
            
            <div v-if="!quotes[priceList.customerPriceListId] || quotes[priceList.customerPriceListId].length === 0" class="text-center py-6">
              <div class="text-gray-500 mb-2">
                <svg class="w-8 h-8 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                </svg>
              </div>
              <p class="text-sm text-gray-600">No quotes yet</p>
            </div>
            
            <div v-else class="space-y-3">
              <div 
                v-for="quote in quotes[priceList.customerPriceListId]" 
                :key="quote.id" 
                class="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors cursor-pointer"
                @click="selectQuote(quote)"
              >
                <div class="flex justify-between items-start">
                  <div>
                    <h5 class="font-medium text-gray-900 mb-1">Quote #{{ quote.number }}</h5>
                    <p class="text-sm text-gray-600">
                      Created: {{ formatDate(quote.createdAt) }}
                    </p>
                    <p class="text-sm text-gray-600">
                      Last updated: {{ formatDate(quote.updatedAt) }}
                    </p>
                  </div>
                  <div class="text-right">
                    <div class="text-lg font-bold text-gray-900">
                      ZAR {{ formatCurrency(quote.total) }}
                    </div>
                    <div class="text-sm text-gray-600">
                      incl. VAT: ZAR {{ formatCurrency(quote.totalInclVat) }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

  <script>
  import { priceListService } from '../services/priceListService.js'
  import QuoteDetail from './QuoteDetail.vue'
  import PriceListView from './PriceListView.vue'

export default {
  name: 'PriceListManager',
  components: {
    QuoteDetail,
    PriceListView
  },
  props: {
    customerId: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      priceLists: [],
      quotes: {},
      loading: false,
      error: null,
      selectedQuote: null,
      selectedPriceList: null
    }
  },
  async mounted() {
    // Add a timeout to prevent infinite loading
    const timeout = setTimeout(() => {
      if (this.loading) {
        console.error('Loading timeout - forcing loading to false')
        this.loading = false
        this.error = 'Loading timeout - please refresh the page'
      }
    }, 10000) // 10 second timeout
    
    try {
      await this.loadCustomerPriceLists()
    } finally {
      clearTimeout(timeout)
    }
  },
  methods: {
    async loadCustomerPriceLists() {
      this.loading = true
      this.error = null
      
      try {
        console.log('Loading customer price lists for customer:', this.customerId)
        const customerPriceLists = await priceListService.getCustomerPriceLists(this.customerId)
        console.log('Customer price lists:', customerPriceLists)
        
        if (!customerPriceLists || customerPriceLists.length === 0) {
          console.log('No customer price lists found')
          this.priceLists = []
          this.loading = false
          return
        }
        
        // Get the actual price list details for each customer price list
        this.priceLists = await Promise.all(
          customerPriceLists.map(async (customerPriceList) => {
            const priceList = await priceListService.getPriceList(customerPriceList.priceListId)
            return {
              ...priceList,
              customerPriceListId: customerPriceList.id
            }
          })
        )
        console.log('Price lists loaded:', this.priceLists)
        
        // Load quotes for each customer price list
        await this.loadQuotesForPriceLists()
      } catch (err) {
        console.error('Error loading customer price lists:', err)
        this.error = err.message || 'Failed to load price lists'
        // Set empty arrays to prevent further errors
        this.priceLists = []
        this.quotes = {}
      } finally {
        this.loading = false
      }
    },
    
    async loadQuotesForPriceLists() {
      try {
        console.log('Loading quotes for price lists...')
        const { quoteService } = await import('../services/quoteService.js')
        
        for (const priceList of this.priceLists) {
          console.log('Loading quotes for price list:', priceList.customerPriceListId)
          const quotes = await quoteService.getQuotesByCustomerPriceList(priceList.customerPriceListId)
          this.quotes[priceList.customerPriceListId] = quotes
          console.log('Quotes loaded for price list:', priceList.customerPriceListId, quotes)
        }
        console.log('All quotes loaded:', this.quotes)
      } catch (err) {
        console.error('Failed to load quotes:', err)
        // Don't let quote loading errors prevent the page from loading
        this.error = 'Failed to load some quotes, but price lists are available'
      }
    },
    
    viewPriceList(priceList) {
      this.selectedPriceList = priceList
    },
    
    async createQuoteFromPriceList(priceList) {
      try {
        const { quoteService } = await import('../services/quoteService.js')
        const newQuote = await quoteService.createQuote(priceList.customerPriceListId)
        
        // Add the new quote to the list
        if (!this.quotes[priceList.customerPriceListId]) {
          this.quotes[priceList.customerPriceListId] = []
        }
        this.quotes[priceList.customerPriceListId].unshift(newQuote)
        
        // Select the new quote
        this.selectQuote(newQuote)
      } catch (err) {
        this.error = err.message || 'Failed to create quote'
      }
    },
    
    selectQuote(quote) {
      this.selectedQuote = quote
    },
    
    handleQuoteUpdated(updatedQuote) {
      // Update the quote in the list
      const priceListId = updatedQuote.customerPriceListId
      if (this.quotes[priceListId]) {
        const index = this.quotes[priceListId].findIndex(q => q.id === updatedQuote.id)
        if (index !== -1) {
          this.quotes[priceListId][index] = updatedQuote
        }
      }
      this.selectedQuote = updatedQuote
    },
    
    handleQuoteDeleted() {
      // Remove the quote from the list
      const priceListId = this.selectedQuote.customerPriceListId
      if (this.quotes[priceListId]) {
        this.quotes[priceListId] = this.quotes[priceListId].filter(q => q.id !== this.selectedQuote.id)
      }
      this.selectedQuote = null
    },
    
    formatDate(dateString) {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      })
    },
    
    formatCurrency(amount) {
      if (!amount) return '0.00'
      return parseFloat(amount).toFixed(2)
    }
  }
}
</script>
