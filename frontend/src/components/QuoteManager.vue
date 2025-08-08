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
        <button @click="loadQuotes" class="btn btn-primary">Try Again</button>
      </div>
    </div>

    <!-- Main Content -->
    <div v-else>
      <!-- Quote List View -->
      <div v-if="!selectedQuote" class="space-y-6">
        <div class="flex justify-between items-center">
          <h2 class="text-2xl font-semibold text-gray-900">Quotes</h2>
          <button @click="createNewQuote" class="btn btn-primary">
            <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
            </svg>
            New Quote
          </button>
        </div>

        <!-- Quote List -->
        <div v-if="quotes.length === 0" class="card text-center py-12">
          <div class="text-gray-500 mb-4">
            <svg class="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
            </svg>
          </div>
          <h3 class="text-lg font-medium text-gray-900 mb-2">No quotes found</h3>
          <p class="text-gray-600 mb-4">Create your first quote to get started.</p>
          <button @click="createNewQuote" class="btn btn-primary">Create Quote</button>
        </div>

        <div v-else class="grid gap-4">
          <div 
            v-for="quote in quotes" 
            :key="quote.id" 
            class="card hover:shadow-md transition-shadow cursor-pointer"
            @click="selectQuote(quote)"
          >
            <div class="flex justify-between items-start">
              <div>
                <div class="flex items-center gap-2 mb-1">
                  <h3 class="text-lg font-medium text-gray-900">Quote #{{ quote.number }}</h3>
                  <span :class="[
                    'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                    quote.status === 'Submitted' 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-yellow-100 text-yellow-800'
                  ]">
                    {{ formatQuoteStatus(quote.status) }}
                  </span>
                </div>
                <p class="text-sm text-gray-600 mb-2">
                  Created: {{ formatDate(quote.createdAt) }}
                </p>
                <p class="text-sm text-gray-600">
                  Last updated: {{ formatDate(quote.updatedAt) }}
                </p>
              </div>
              <div class="text-right">
                <div class="text-xl font-bold text-gray-900">
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

      <!-- Quote Detail View -->
      <QuoteDetail 
        v-else 
        :quote="selectedQuote" 
        @back="selectedQuote = null"
        @quote-updated="handleQuoteUpdated"
        @quote-deleted="handleQuoteDeleted"
      />
      
      <!-- Back Button -->
      <div class="mt-6">
        <button @click="$emit('back')" class="btn btn-secondary">
          <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path>
          </svg>
          Back to Price Lists
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import QuoteDetail from './QuoteDetail.vue'
import { quoteService } from '../services/quoteService.js'

export default {
  name: 'QuoteManager',
  components: {
    QuoteDetail
  },
  props: {
    customerId: {
      type: String,
      required: true
    }
  },
  data() {
    return {
      quotes: [],
      selectedQuote: null,
      loading: false,
      error: null
    }
  },
  async mounted() {
    await this.loadQuotes()
  },
  methods: {
    async loadQuotes() {
      this.loading = true
      this.error = null
      
      try {
        this.quotes = await quoteService.getQuotesByCustomer(this.customerId)
      } catch (err) {
        this.error = err.message || 'Failed to load quotes'
      } finally {
        this.loading = false
      }
    },
    
    selectQuote(quote) {
      this.selectedQuote = quote
    },
    
    async createNewQuote() {
      try {
        // Get the customer's price lists
        const { priceListService } = await import('../services/priceListService.js')
        const customerPriceLists = await priceListService.getCustomerPriceLists(this.customerId)
        
        if (customerPriceLists.length === 0) {
          this.error = 'No price lists assigned to this customer.'
          return
        }
        
        // Use the first available customer price list
        const customerPriceList = customerPriceLists[0]
        const newQuote = await quoteService.createQuote(customerPriceList.id)
        this.quotes.unshift(newQuote)
        this.selectQuote(newQuote)
      } catch (err) {
        this.error = err.message || 'Failed to create quote'
      }
    },
    
    handleQuoteUpdated(updatedQuote) {
      const index = this.quotes.findIndex(q => q.id === updatedQuote.id)
      if (index !== -1) {
        this.quotes[index] = updatedQuote
      }
      this.selectedQuote = updatedQuote
    },
    
    handleQuoteDeleted() {
      this.quotes = this.quotes.filter(q => q.id !== this.selectedQuote.id)
      this.selectedQuote = null
    },
    
    formatDate(dateString) {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    },
    
    formatCurrency(amount) {
      return parseFloat(amount).toFixed(2)
    },

    formatQuoteStatus(status) {
      if (!status) return 'Draft'
      return status === 'Submitted' ? 'Submitted' : 'Draft'
    }
  }
}
</script>
