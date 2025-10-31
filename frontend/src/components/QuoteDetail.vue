<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex justify-between items-center">
      <div class="flex items-center space-x-4">
        <button @click="$emit('back')" class="btn btn-secondary">
          Back to Quotes
        </button>
        <div class="flex items-center gap-2">
          <h2 class="text-2xl font-semibold text-gray-900">{{ quote.name || ('Quote #' + (quote.number || '')) }}</h2>
          <button 
            v-if="isDraft"
            @click="openNameDialog"
            class="text-gray-500 hover:text-gray-700"
            title="Edit quote name"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </div>
       <div class="flex space-x-2">
        <button 
          v-if="quote.status === 'Draft' || !quote.status" 
          @click="submitQuote" 
          class="btn bg-green-600 hover:bg-green-700 text-white"
          :disabled="isSubmitDisabled"
          :class="{ 'opacity-50 cursor-not-allowed': isSubmitDisabled }"
        >
          <span v-if="submittingQuote" class="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></span>
          {{ submittingQuote ? 'Submitting...' : 'Submit Quote' }}
        </button>
         <button v-if="isDraft" @click="deleteQuote" class="btn btn-danger">
          Delete Quote
        </button>
      </div>
    </div>

    <!-- Quote Info -->
    <div class="card">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Quote Number</label>
          <p class="text-lg font-semibold text-gray-900">{{ quote.number }}</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Status</label>
          <div class="flex items-center">
            <span :class="[
              'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
              quote.status === 'Submitted'
                ? 'bg-green-100 text-green-800'
                : (quote.status === 'Approved' ? 'bg-blue-100 text-blue-800' : 'bg-yellow-100 text-yellow-800')
            ]">
              {{ formatQuoteStatus(quote.status) }}
            </span>
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Created By</label>
          <p class="text-gray-900">{{ quote.createdByName || '—' }}</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Last Updated</label>
          <p class="text-gray-900">{{ formatDate(quote.updatedAt) }}</p>
        </div>

        <!-- Submission/Approval Meta -->
        <template v-if="isSubmitted || isApproved">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Submitted By</label>
            <p class="text-gray-900">{{ quote.submittedByName || '—' }}</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Submitted At</label>
            <p class="text-gray-900">{{ quote.submittedAt ? formatDate(quote.submittedAt) : '—' }}</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Approved By</label>
            <p class="text-gray-900">{{ quote.approvedByName || '—' }}</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Approved At</label>
            <p class="text-gray-900">{{ quote.approvedAt ? formatDate(quote.approvedAt) : '—' }}</p>
          </div>
        </template>
      </div>
    </div>

    <!-- Delivery Address Selection (Dialog + Card) -->
    <div class="card">
      <div class="flex items-center justify-between mb-2">
        <label class="block text-sm font-medium text-gray-700">Delivery Address <span class="text-red-600" v-if="!productsReadOnly">*</span></label>
        <span v-if="!productsReadOnly && addressSubmitAttempted && !selectedAddressId" class="text-xs text-red-600">Address is required</span>
      </div>
      <div class="flex items-start gap-4">
        <div class="w-full">
          <div v-if="loadingAddresses" class="rounded-lg border border-gray-200 p-4 text-sm text-gray-500 bg-gray-50">Loading addresses...</div>
          <div 
            v-else-if="!selectedAddressId" 
            class="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-600 transition"
            :class="{ 'cursor-pointer hover:border-blue-400': !productsReadOnly && !loadingAddresses, 'cursor-not-allowed': productsReadOnly || loadingAddresses }"
            role="button"
            tabindex="0"
            @click="openAddressDialog"
            @keydown.enter="openAddressDialog"
          >
            No address selected
          </div>
          <div 
            v-else 
            class="rounded-lg border border-gray-200 p-4 bg-white transition w-full"
            :class="{ 'cursor-pointer hover:border-blue-400': !productsReadOnly && !loadingAddresses, 'cursor-not-allowed': productsReadOnly || loadingAddresses }"
            role="button"
            tabindex="0"
            @click="openAddressDialog"
            @keydown.enter="openAddressDialog"
          >
            <div class="md:grid md:grid-cols-2 md:gap-6">
              <!-- Left: Name/Org/Contact -->
              <div class="space-y-1">
                <div class="text-base font-semibold text-gray-900">{{ selectedAddress.name }}</div>
                <div v-if="selectedAddress.organisation" class="text-sm text-gray-700">{{ selectedAddress.organisation }}</div>
                <div v-if="selectedAddress.contactPerson || selectedAddress.contactPhone || selectedAddress.contactEmail" class="space-y-0.5">
                  <p v-if="selectedAddress.contactPerson" class="text-sm text-gray-700">Contact: {{ selectedAddress.contactPerson }}</p>
                  <p v-if="selectedAddress.contactPhone" class="text-sm text-gray-700">Phone: {{ selectedAddress.contactPhone }}</p>
                  <p v-if="selectedAddress.contactEmail" class="text-sm text-gray-700">Email: {{ selectedAddress.contactEmail }}</p>
                </div>
              </div>
              <!-- Right: Physical Address -->
              <div class="space-y-1 mt-3 md:mt-6">
                <div class="text-sm text-gray-700">{{ selectedAddress.addressLine1 }}</div>
                <div v-if="selectedAddress.addressLine2" class="text-sm text-gray-700">{{ selectedAddress.addressLine2 }}</div>
                <div class="text-sm text-gray-700">{{ selectedAddress.suburb }}, {{ selectedAddress.city }}, {{ selectedAddress.province }} {{ selectedAddress.postalCode }}</div>
                <div v-if="selectedAddress.deliveryNotes" class="text-sm text-gray-700">{{ selectedAddress.deliveryNotes }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Address Picker Dialog -->
      <div v-if="showAddressDialog" class="fixed inset-0 z-50 flex items-center justify-center">
        <div class="absolute inset-0 bg-black bg-opacity-50" @click="closeAddressDialog"></div>
        <div class="relative bg-white rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-hidden">
          <div class="flex items-center justify-between p-4 border-b border-gray-200">
            <h3 class="text-lg font-semibold text-gray-900">Select Delivery Address</h3>
            <button @click="closeAddressDialog" class="text-gray-400 hover:text-gray-600">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
          <div class="p-4 overflow-y-auto max-h-[calc(90vh-120px)]">
            <div v-if="deliveryAddresses.length === 0" class="text-center text-sm text-gray-600 py-8">No delivery addresses found.</div>
            <div v-else class="space-y-4">
              <div 
                v-for="addr in deliveryAddresses" 
                :key="addr.id"
                class="border rounded-lg p-4 hover:border-blue-500 hover:shadow cursor-pointer transition w-full"
                @click="selectAddress(addr.id)"
              >
                <div class="md:grid md:grid-cols-2 md:gap-6">
                  <!-- Left: Name/Org/Contact -->
                  <div class="space-y-1">
                    <div class="text-base font-semibold text-gray-900">{{ addr.name }}</div>
                    <div v-if="addr.organisation" class="text-sm text-gray-700">{{ addr.organisation }}</div>
                    <div v-if="addr.contactPerson || addr.contactPhone || addr.contactEmail" class="space-y-0.5">
                      <p v-if="addr.contactPerson" class="text-sm text-gray-700">Contact: {{ addr.contactPerson }}</p>
                      <p v-if="addr.contactPhone" class="text-sm text-gray-700">Phone: {{ addr.contactPhone }}</p>
                      <p v-if="addr.contactEmail" class="text-sm text-gray-700">Email: {{ addr.contactEmail }}</p>
                    </div>
                  </div>
                  <!-- Right: Physical Address -->
                  <div class="space-y-1 mt-3 md:mt-6">
                    <div class="text-sm text-gray-700">{{ addr.addressLine1 }}</div>
                    <div v-if="addr.addressLine2" class="text-sm text-gray-700">{{ addr.addressLine2 }}</div>
                    <div class="text-sm text-gray-700">{{ addr.suburb }}, {{ addr.city }}, {{ addr.province }} {{ addr.postalCode }}</div>
                    <div v-if="addr.deliveryNotes" class="text-sm text-gray-700">{{ addr.deliveryNotes }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="p-4 border-t border-gray-200 flex justify-end">
            <button @click="closeAddressDialog" class="btn btn-secondary">Close</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Products Section -->
    <div class="card">

      <!-- Products Loading State -->
      <div v-if="loadingProducts" class="flex justify-center items-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>

      <!-- Products List -->
      <div v-else-if="quoteProducts.length === 0" class="text-center py-8">
        <div class="text-gray-500 mb-4">
          <svg class="w-12 h-12 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21h18"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21v-4h6"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 7l3 3-3 3-3-3 3-3z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 6l3 3"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10h3"/>
          </svg>
        </div>
        <h4 class="text-lg font-medium text-gray-900 mb-2">No products added</h4>
        <p class="text-gray-600">Add products to this quote to get started.</p>
      </div>

      <div v-else class="space-y-4">
        <!-- Column Headers -->
        <div class="flex justify-between items-center px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg">
          <div class="flex items-center space-x-4">
            <div class="min-h-[2rem] flex flex-col justify-center">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Product</h4>
            </div>
          </div>
          <div class="flex items-center space-x-4">
            <div class="w-12 text-center">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide"></h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Quantity</h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Price</h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Total</h4>
            </div>
          </div>
        </div>
        
        <div 
          v-for="product in quoteProducts" 
          :key="product.id" 
          class="border border-gray-200 rounded-lg p-2 hover:bg-gray-50 transition-colors"
        >
          <div class="flex justify-between items-center">
              <div class="flex items-center space-x-4">
              <div class="relative w-12 h-12">
                <img 
                  v-if="productDetails[product.productId]?.image?.url" 
                  :src="productDetails[product.productId].image.url" 
                  :alt="productDetails[product.productId]?.name"
                  class="w-12 h-12 object-contain rounded-lg cursor-pointer bg-white"
                  @mouseenter="showImagePreview(product.productId, $event)"
                  @mousemove="updateImagePreviewPosition($event)"
                  @mouseleave="hideImagePreview"
                />
                <div 
                  v-else 
                  class="w-12 h-12 bg-gray-200 rounded-lg flex items-center justify-center"
                >
                  <svg class="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                  </svg>
                </div>
              </div>
              <div class="min-h-[2rem] flex flex-col justify-center">
                <h4 class="font-medium text-gray-900">{{ productDetails[product.productId]?.name || 'Product' }}</h4>
                <p class="text-sm text-gray-600">SKU: {{ productDetails[product.productId]?.sku || 'N/A' }}</p>
              </div>
            </div>
            <div class="flex items-center space-x-4">
              <div class="w-12 text-center">
            <button 
                  v-if="!productsReadOnly"
              @click="removeProduct(product.id)" 
                  class="text-red-600 hover:text-red-800 p-2 rounded"
              title="Remove product"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
              </svg>
            </button>
              </div>
              <div class="w-20 text-right">
                <input 
                  v-if="!productsReadOnly"
                  type="number" 
                  :value="product.quantity" 
                  @change="updateProductQuantity(product.id, $event.target.value)"
                  class="input w-16 text-sm text-center"
                  min="0"
                  step="1"
                />
                <p v-else class="text-sm font-medium text-gray-900 text-center">
                  {{ product.quantity }}
                </p>
              </div>
              <div class="w-20 text-right">
                <p class="text-sm font-medium text-gray-900">{{ formatCurrency(product.price) }}</p>
              </div>
              <div class="w-20 text-right">
                <p class="text-sm font-bold text-gray-900">{{ formatCurrency(product.total) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Product Action Buttons -->
      <div v-if="isDraft" class="flex justify-end items-center space-x-3 mt-6 pt-4 border-t border-gray-200">
        <button 
          @click="showAddProductModal = true" 
          class="btn btn-primary"
          :disabled="productsReadOnly"
          :class="{ 'opacity-50 cursor-not-allowed': productsReadOnly }"
        >
          Add Product
        </button>
        <button 
          @click="toggleProductsReadOnly" 
          class="btn btn-secondary"
          :disabled="(!productsReadOnly && (quoteProducts.length === 0 || !selectedAddressId))"
          :class="{ 'opacity-50 cursor-not-allowed': (!productsReadOnly && (quoteProducts.length === 0 || !selectedAddressId)) }"
        >
          {{ productsReadOnly ? 'Edit Products' : 'Continue with Shipping' }}
        </button>
      </div>
    </div>

    <!-- Equipment Boxes Section -->
    <div v-if="productsReadOnly" class="card">
      <div class="mb-4" v-if="isDraft">
        <div class="flex gap-3">
          <button
            type="button"
            @click="selectBoxType('PlasticEquipment')"
            :disabled="loading"
            :class="[
              'flex items-center gap-3 px-3 py-2 rounded-md border transition',
              selectedBoxType === 'PlasticEquipment' ? 'border-blue-600 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
            ]"
          >
            <svg class="w-5 h-5 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="4" y="4" width="16" height="12" rx="2" ry="2" stroke-width="2"/>
              <path d="M4 12h16" stroke-width="2"/>
            </svg>
            <div class="text-left">
              <div class="text-sm font-medium text-gray-900">Plastic Equipment</div>
              <div class="text-xs text-gray-500">Plastic tote box</div>
            </div>
          </button>
          <button
            type="button"
            @click="selectBoxType('Cardboard')"
            :disabled="loading"
            :class="[
              'flex items-center gap-3 px-3 py-2 rounded-md border transition',
              selectedBoxType === 'Cardboard' ? 'border-blue-600 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
            ]"
          >
            <svg class="w-5 h-5 text-yellow-600" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M3 7l9-4 9 4-9 4-9-4z" stroke-width="2"/>
              <path d="M3 7v10l9 4 9-4V7" stroke-width="2"/>
            </svg>
            <div class="text-left">
              <div class="text-sm font-medium text-gray-900">Cardboard</div>
              <div class="text-xs text-gray-500">Plain cardboard box</div>
            </div>
          </button>
        </div>
      </div>

      <!-- Equipment Boxes List -->
      <div v-if="loadingEquipmentBoxes" class="flex justify-center items-center py-8">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>

      <div v-else-if="!selectedBoxType" class="text-center py-8">
        <div class="text-gray-500 mb-4">
          <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
          </svg>
        </div>
        <h4 class="text-lg font-medium text-gray-900 mb-2">No equipment boxes selected</h4>
        <p class="text-gray-600">Select a box type to automatically calculate packaging requirements.</p>
      </div>

      <div v-else-if="equipmentBoxes.length === 0" class="text-center py-8">
        <div class="text-gray-500 mb-4">
          <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
          </svg>
        </div>
        <h4 class="text-lg font-medium text-gray-900 mb-2">No equipment boxes needed</h4>
        <p class="text-gray-600">The current products don't require any equipment boxes.</p>
      </div>

      <div v-else class="space-y-3">
        <!-- Equipment Box Headers -->
        <div class="flex justify-between items-center px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg">
          <div class="flex items-center space-x-4">
            <div class="min-h-[2rem] flex flex-col justify-center">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Packaging</h4>
            </div>
          </div>
          <div class="flex items-center space-x-4">
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Quantity</h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Price</h4>
            </div>
            <div class="w-20 text-right">
              <h4 class="text-xs font-medium text-gray-700 uppercase tracking-wide">Total</h4>
            </div>
          </div>
        </div>
        
        <div 
          v-for="equipmentBox in equipmentBoxes" 
          :key="equipmentBox.id" 
          class="border border-gray-200 rounded-lg p-2 hover:bg-gray-50 transition-colors"
        >
          <div class="flex justify-between items-center">
            <div class="flex items-center space-x-4">
              <div class="relative w-12 h-12">
                <img
                  v-if="equipmentBoxDetails[equipmentBox.equipmentBoxId]?.image?.url"
                  :src="equipmentBoxDetails[equipmentBox.equipmentBoxId].image.url"
                  :alt="equipmentBoxDetails[equipmentBox.equipmentBoxId]?.name || 'Equipment Box'"
                  class="w-12 h-12 object-contain rounded-lg cursor-pointer bg-white"
                  @mouseenter="showBoxImagePreview(equipmentBox.equipmentBoxId, $event)"
                  @mousemove="updateImagePreviewPosition($event)"
                  @mouseleave="hideImagePreview"
                />
                <div v-else class="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                  <svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path>
                  </svg>
                </div>
              </div>
              <div class="min-h-[2rem] flex flex-col justify-center">
                <h4 class="font-medium text-gray-900">
                  {{ equipmentBoxDetails[equipmentBox.equipmentBoxId]?.name || `Equipment Box ${equipmentBox.equipmentBoxId}` }}
                </h4>
                <p class="text-xs text-gray-500">
                  Dimensions: {{ formatDimensions(equipmentBoxDetails[equipmentBox.equipmentBoxId]) }}
                </p>
              </div>
            </div>
                          <div class="flex items-center space-x-4">
                <div class="w-20 text-right">
                  <p class="text-sm font-medium text-gray-900">{{ equipmentBox.quantity }}</p>
                </div>
                <div class="w-20 text-right">
                  <p class="text-sm font-medium text-gray-900">{{ formatCurrency(equipmentBox.price) }}</p>
                </div>
                <div class="w-20 text-right">
                  <p class="text-sm font-bold text-gray-900">{{ formatCurrency(equipmentBox.total) }}</p>
                </div>
              </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Shipping Details Section -->
    <div v-if="productsReadOnly" class="card">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Total Shipment Weight</label>
          <div class="text-2xl font-bold text-gray-900">
            {{ formatWeight(totalShipmentWeight) }}
          </div>
          <p class="text-sm text-gray-600 mt-1">
            Combined weight of all products and equipment boxes
          </p>
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Weight Breakdown</label>
          <div class="space-y-2">
            <div class="flex justify-between text-sm">
              <span class="text-gray-600">Products</span>
              <span class="font-medium">{{ formatWeight(productsWeight) }}</span>
            </div>
            <div v-if="selectedBoxType && equipmentBoxes.length > 0" class="flex justify-between text-sm">
              <span class="text-gray-600">Equipment Boxes</span>
              <span class="font-medium">{{ formatWeight(equipmentBoxesWeight) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Delivery Rates Section -->
      <div class="mt-6 border-t pt-6">
        <div v-if="deliveryRates">
          <!-- Delivery Summary -->
          <div class="bg-green-50 border border-green-200 rounded-lg p-4">
            <div class="flex items-start justify-between">
              <div class="flex-shrink-0">
                <svg class="h-5 w-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                </svg>
              </div>
              <div class="ml-3 flex-1">
                <h3 class="text-sm font-medium text-green-800">The Courier Guy delivery quote</h3>
                                  <div class="mt-2 text-sm text-green-700">
                    <p><strong>{{ deliveryRates.selectedDeliveryService }}</strong> - ZAR {{ formatCurrency(deliveryRates.selectedDeliveryFees) }}</p>
                    <p class="mt-1 text-xs">
                      {{ deliveryRates.totalParcels }} parcels • 
                      Actual Weight {{ deliveryRates.totalWeightKg?.toFixed(2) || '0.00' }} kg
                      <span v-if="deliveryRates.chargedWeight">
                        • Charged Weight {{ deliveryRates.chargedWeight.toFixed(0) }} kg
                      </span>
                    </p>
                  </div>
              </div>
              <div class="ml-3">
                <button 
                  v-if="hasDeliveryInfo"
                  class="text-xs text-green-700 hover:text-green-900 underline"
                  @click="openDeliveryInfoDialog"
                >
                  View details
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Delivery Rates Error -->
      <div v-if="deliveryRatesError" class="mt-6 border-t pt-6">
        <div class="bg-red-50 border border-red-200 rounded-lg p-4">
          <div class="flex">
            <div class="flex-shrink-0">
              <svg class="h-5 w-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="ml-3 flex-1">
              <h3 class="text-sm font-medium text-red-800">Failed to calculate delivery rates</h3>
              <div class="mt-2 text-sm text-red-700">
                <p>{{ deliveryRatesError }}</p>
              </div>
              <div class="mt-3">
                <button 
                  @click="calculateDeliveryRates"
                  :disabled="loadingDeliveryRates"
                  class="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-red-700 bg-red-100 hover:bg-red-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg v-if="loadingDeliveryRates" class="animate-spin -ml-1 mr-2 h-4 w-4 text-red-700" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {{ loadingDeliveryRates ? 'Retrying...' : 'Retry' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Totals Section -->
    <div class="card">
      <div class="flex justify-end">
        <div class="w-80 space-y-2">
          <!-- Products Subtotal -->
          <div class="flex justify-between">
            <span class="text-gray-600">Products</span>
            <span class="font-medium">{{ formatCurrency(quote.totalProductPrice || 0) }}</span>
          </div>
          
                      <!-- Equipment Boxes Subtotal -->
            <div class="flex justify-between">
              <span class="text-gray-600">Equipment Boxes</span>
              <span class="font-medium">{{ quote.totalEquipmentBoxPrice && quote.totalEquipmentBoxPrice > 0 ? formatCurrency(quote.totalEquipmentBoxPrice) : '0.00' }}</span>
            </div>
            
            <!-- Delivery Fees -->
          <div class="flex justify-between">
              <span class="text-gray-600">Delivery</span>
              <span class="font-medium">{{ quote.totalDeliveryFees && quote.totalDeliveryFees > 0 ? formatCurrency(quote.totalDeliveryFees) : '0.00' }}</span>
          </div>
          
          <!-- Grand Total -->
          <div class="border-t pt-2">
            <div class="flex justify-between">
              <span class="text-sm text-gray-600">Total excl. VAT</span>
              <span class="text-sm font-medium text-gray-900">ZAR {{ formatCurrency(grandTotal) }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-lg font-semibold">Total incl. VAT</span>
              <span class="text-lg font-bold text-gray-900">ZAR {{ formatCurrency(grandTotalInclVat) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Delivery Info Dialog -->
    <div v-if="showDeliveryInfoDialog" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black bg-opacity-50" @click="closeDeliveryInfoDialog"></div>
      <div class="relative bg-white rounded-lg shadow-xl w-full max-w-4xl mx-4 max-h-[90vh] overflow-hidden">
        <div class="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 class="text-lg font-semibold text-gray-900">Delivery details</h3>
          <button @click="closeDeliveryInfoDialog" class="text-gray-400 hover:text-gray-600">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="p-4 overflow-auto max-h-[calc(90vh-160px)] space-y-6">
          <!-- Selected service -->
          <div class="border border-gray-200 rounded-lg p-4">
            <div class="flex items-start justify-between">
              <div>
                <div class="text-base font-semibold text-gray-900">{{ quote.deliveryService || parsedDelivery.selectedRate?.service_level?.name || 'Selected service' }}</div>
                <div class="text-sm text-gray-700 mt-1">Price: ZAR {{ formatCurrency(quote.totalDeliveryFees || parsedDelivery.selectedRate?.rate || 0) }}</div>
                <div class="text-sm text-gray-700 mt-1 flex flex-wrap gap-4">
                  <span v-if="quote.chargedWeightInGrams || parsedDelivery.selectedRate?.charged_weight">Charged: {{ formatChargedKg }} kg</span>
                  <span v-if="parsedDelivery.selectedRate?.actual_weight">Actual: {{ parsedDelivery.selectedRate.actual_weight.toFixed(2) }} kg</span>
                  <span v-if="parsedDelivery.selectedRate?.volumetric_weight">Volumetric: {{ parsedDelivery.selectedRate.volumetric_weight.toFixed(2) }} kg</span>
                </div>
                <div v-if="parsedDelivery.selectedRate?.service_level?.delivery_date_from || parsedDelivery.selectedRate?.service_level?.delivery_date_to" class="text-xs text-gray-600 mt-1">
                  Delivery window: 
                  <span v-if="parsedDelivery.selectedRate?.service_level?.delivery_date_from">{{ formatDeliveryDate(parsedDelivery.selectedRate.service_level.delivery_date_from) }}</span>
                  <span v-if="parsedDelivery.selectedRate?.service_level?.delivery_date_to"> - {{ formatDeliveryDate(parsedDelivery.selectedRate.service_level.delivery_date_to) }}</span>
                </div>
              </div>
              <div class="text-right text-sm text-gray-700">
                <div v-if="parsedDelivery.selectedRate?.rate_excluding_vat">Excl. VAT: ZAR {{ formatCurrency(parsedDelivery.selectedRate.rate_excluding_vat) }}</div>
                <div v-if="parsedDelivery.selectedRate?.base_rate?.vat">VAT: ZAR {{ formatCurrency(parsedDelivery.selectedRate.base_rate.vat) }}</div>
                <div v-if="parsedDelivery.selectedRate?.base_rate?.vat_percentage">VAT %: {{ parsedDelivery.selectedRate.base_rate.vat_percentage }}%</div>
              </div>
            </div>
          </div>

          <!-- Alternative rates -->
          <div v-if="parsedDelivery.otherRates.length" class="border border-gray-200 rounded-lg p-4">
            <div class="text-sm font-medium text-gray-900 mb-3">Available services</div>
            <div class="overflow-x-auto">
              <table class="min-w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-600">
                    <th class="py-2 pr-4">Service</th>
                    <th class="py-2 pr-4">Price (ZAR)</th>
                    <th class="py-2 pr-4">Charged (kg)</th>
                    <th class="py-2 pr-4">Actual (kg)</th>
                    <th class="py-2 pr-4">Volumetric (kg)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in parsedDelivery.otherRates" :key="r._key" class="border-t">
                    <td class="py-2 pr-4 text-gray-800">{{ r.service_level?.name || '-' }}</td>
                    <td class="py-2 pr-4 text-gray-800">{{ formatCurrency(r.rate || 0) }}</td>
                    <td class="py-2 pr-4 text-gray-800">{{ r.charged_weight != null ? r.charged_weight.toFixed(0) : '-' }}</td>
                    <td class="py-2 pr-4 text-gray-800">{{ r.actual_weight != null ? r.actual_weight.toFixed(2) : '-' }}</td>
                    <td class="py-2 pr-4 text-gray-800">{{ r.volumetric_weight != null ? r.volumetric_weight.toFixed(2) : '-' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Raw JSON toggle -->
          <div>
            <button class="text-xs text-gray-600 hover:text-gray-800 underline" @click="showRawJson = !showRawJson">{{ showRawJson ? 'Hide raw JSON' : 'Show raw JSON' }}</button>
            <div v-if="showRawJson" class="mt-2">
              <pre class="text-xs text-gray-800 whitespace-pre-wrap break-words">{{ formattedDeliveryInfo }}</pre>
            </div>
          </div>
        </div>
        <div class="p-4 border-t border-gray-200 flex justify-end">
          <button @click="closeDeliveryInfoDialog" class="btn btn-secondary">Close</button>
        </div>
      </div>
    </div>

    <!-- Edit Quote Name Dialog -->
    <div v-if="showNameDialog" class="fixed inset-0 z-50 flex items-center justify-center">
      <div class="absolute inset-0 bg-black bg-opacity-50" @click="closeNameDialog"></div>
      <div class="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        <div class="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 class="text-lg font-semibold text-gray-900">Edit quote name</h3>
          <button @click="closeNameDialog" class="text-gray-400 hover:text-gray-600">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="p-4 space-y-3">
          <label class="block text-sm font-medium text-gray-700">Name</label>
          <input v-model="editName" type="text" class="input" placeholder="e.g. Term 3, 2025" />
        </div>
        <div class="p-4 border-t border-gray-200 flex justify-end gap-2">
          <button @click="closeNameDialog" class="btn btn-secondary">Cancel</button>
          <button @click="saveName" class="btn btn-primary" :disabled="savingName || !editName.trim()" :class="{ 'opacity-50 cursor-not-allowed': savingName || !editName.trim() }">{{ savingName ? 'Saving...' : 'Save' }}</button>
        </div>
      </div>
    </div>

    <!-- Image Preview Overlay -->
    <div 
      v-if="imagePreview.show"
      :style="{
        position: 'fixed',
        top: imagePreview.y + 'px',
        left: imagePreview.x + 'px',
        zIndex: 1000,
        pointerEvents: 'none'
      }"
      class="bg-white border border-gray-300 rounded-lg shadow-lg p-2"
    >
      <img 
        :src="imagePreview.src" 
        :alt="imagePreview.alt"
        class="w-60 h-60 object-contain rounded bg-white"
      />
    </div>

    <!-- Add Product Modal -->
    <AddProductModal 
      v-if="showAddProductModal"
      :quote-id="quote.id"
        :price-list-id="customerPriceList?.priceListId"
        :existing-quote-products="quoteProducts"
      @close="showAddProductModal = false"
      @product-added="handleProductAdded"
    />
  </div>
</template>

<script>
import AddProductModal from './AddProductModal.vue'
import { quoteService } from '../services/quoteService.js'
import { productService } from '../services/productService.js'
import { deliveryService } from '../services/deliveryService.js'

export default {
  name: 'QuoteDetail',
  components: {
    AddProductModal
  },
  props: {
    quote: {
      type: Object,
      required: true
    },
    customerId: {
      type: String,
      required: false
    }
  },
  data() {
    return {
      productPrices: [], // The price list
      quoteProducts: [],
      productDetails: {}, // Store product details by productId
      showAddProductModal: false,
      loading: false,
      customerPriceList: null,
      equipmentBoxes: [],
      equipmentBoxDetails: {}, // Store equipment box details by equipmentBoxId
      selectedBoxType: '',
      loadingEquipmentBoxes: false,
      loadingProducts: false,
      imagePreview: {
        show: false,
        src: '',
        alt: '',
        x: 0,
        y: 0
      },
      deliveryRates: null,
      loadingDeliveryRates: false,
      deliveryRatesError: null,
      submittingQuote: false,
      productsReadOnly: false,
      deliveryAddresses: [],
      loadingAddresses: false,
      selectedAddressId: '',
      addressSubmitAttempted: false,
      showAddressDialog: false,
      showDeliveryInfoDialog: false,
      showRawJson: false,
      showNameDialog: false,
      editName: '',
      savingName: false
    }
  },
  async mounted() {
    // Initialize loading states
    this.loadingProducts = true
    this.loadingEquipmentBoxes = true
    this.loadingAddresses = true

    await this.refreshQuoteData()
    await this.loadCustomerPriceList()
    await this.loadQuoteProducts()
    await this.loadProductDetails()
    this.initializeBoxType()
    await this.loadEquipmentBoxes()
    await this.loadDeliveryAddresses()
    // hydrate selected from quote if present
    if (this.quote.deliveryAddressId) {
      this.selectedAddressId = this.quote.deliveryAddressId
    }
    this.checkExistingDeliveryDetails()
    // If delivery already set on quote, lock products and show delivery sections
    if (this.quote.deliveryService && this.quote.totalDeliveryFees && this.quote.totalDeliveryFees > 0) {
      this.productsReadOnly = true
    }

    // Always lock editing for non-draft quotes
    if (!(this.quote?.status === 'Draft' || !this.quote?.status)) {
      this.productsReadOnly = true
    }

    // Hydrate submitted/approved user names if only IDs present
    this.hydrateActionUsers()
    this.hydrateCreatedByUser()
  },
  computed: {
    isSubmitted() {
      return this.quote?.status === 'Submitted'
    },
    isApproved() {
      return this.quote?.status === 'Approved'
    },
    isDraft() {
      const status = this.quote?.status
      return !status || status === 'Draft'
    },
    hasDeliveryInfo() {
      return !!this.quote?.deliveryRawJson
    },
    formattedDeliveryInfo() {
      try {
        return JSON.stringify(this.quote?.deliveryRawJson ?? {}, null, 2)
      } catch (_) {
        // In case it's a string that's not JSON, just show it
        return String(this.quote?.deliveryRawJson ?? '')
      }
    },
    parsedDelivery() {
      const raw = this.quote?.deliveryRawJson
      let data = {}
      if (!raw) return { selectedRate: null, otherRates: [] }
      if (typeof raw === 'string') {
        try { data = JSON.parse(raw) } catch (_) { data = {} }
      } else {
        data = raw
      }
      const rates = Array.isArray(data.rates) ? data.rates : []
      const sorted = [...rates].sort((a, b) => (a.rate ?? Infinity) - (b.rate ?? Infinity))
      const selectedRate = sorted[0] || null
      const otherRates = sorted.slice(1).map((r, idx) => ({ ...r, _key: idx }))
      return { selectedRate, otherRates }
    },
    formatChargedKg() {
      if (this.quote?.chargedWeightInGrams) return (this.quote.chargedWeightInGrams / 1000).toFixed(0)
      const cw = this.parsedDelivery.selectedRate?.charged_weight
      return cw != null ? Number(cw).toFixed(0) : '0'
    },
    selectedAddress() {
      const list = this.deliveryAddresses || []
      return list.find(a => a.id === this.selectedAddressId) || {}
    },
    // Note: Totals are now pulled from the quote response from getQuote
    // and should include equipment boxes and delivery fees from the backend
    isDeliverySet() {
      return !!(this.quote.totalDeliveryFees && this.quote.totalDeliveryFees > 0)
    },
    isSubmitDisabled() {
      return !this.isDeliverySet 
        || !this.productsReadOnly 
        || this.loading 
        || this.loadingEquipmentBoxes 
        || this.loadingDeliveryRates 
        || this.submittingQuote
    },
    grandTotal() {
      return this.quote.total || 0
    },
    vat() {
      return this.quote.vat || 0
    },
    grandTotalInclVat() {
      return this.quote.totalInclVat || 0
    },
    productsWeight() {
      return this.quoteProducts.reduce((totalWeight, quoteProduct) => {
        const product = this.productDetails[quoteProduct.productId]
        if (product && product.weightInGrams) {
          return totalWeight + (Number(product.weightInGrams) * quoteProduct.quantity)
        }
        return totalWeight
      }, 0)
    },
    equipmentBoxesWeight() {
      return this.equipmentBoxes.reduce((totalWeight, equipmentBox) => {
        const equipmentBoxDetail = this.equipmentBoxDetails[equipmentBox.equipmentBoxId]
        if (equipmentBoxDetail && equipmentBoxDetail.weightInGrams) {
          return totalWeight + (Number(equipmentBoxDetail.weightInGrams) * equipmentBox.quantity)
        }
        return totalWeight
      }, 0)
    },
    totalShipmentWeight() {
      return this.productsWeight + this.equipmentBoxesWeight
    }
  },
  watch: {
    // Reset delivery rates when products change
    'quote.products': {
      handler() {
        // Hydrate from backend if delivery details exist to avoid flicker
        this.checkExistingDeliveryDetails()
      },
      deep: true
    },
    // Hydrate delivery details any time the quote object updates from parent
    quote: {
      handler() {
        this.$nextTick(() => {
          this.checkExistingDeliveryDetails()
          // If delivery already set on quote, lock products and show delivery sections
          if (this.quote.deliveryService && this.quote.totalDeliveryFees && this.quote.totalDeliveryFees > 0) {
            this.productsReadOnly = true
          }
          // Always lock editing for non-draft quotes
          if (!(this.quote?.status === 'Draft' || !this.quote?.status)) {
            this.productsReadOnly = true
          }
          // Re-hydrate user display names whenever quote changes
          this.hydrateActionUsers()
          this.hydrateCreatedByUser()
        })
      },
      deep: false
    },
    // Reset delivery rates when equipment boxes change
    equipmentBoxes: {
      handler() {
        // Do not clear; hydrate from backend state to prevent flicker/disappear
        this.$nextTick(() => {
          this.checkExistingDeliveryDetails()
        })
      },
      deep: true
    },
    // Update selected box type when quote boxType changes
    'quote.boxType': {
      handler(newBoxType) {
        if (newBoxType && newBoxType !== this.selectedBoxType) {
          this.selectedBoxType = newBoxType
          console.log('Box type updated from quote:', newBoxType)
        }
      },
      immediate: true
    }
  },
  methods: {
    async hydrateActionUsers() {
      try {
        const submitId = this.quote?.submittedById || this.quote?.submittedBy
        const approveId = this.quote?.approvedById || this.quote?.approvedBy
        const needsSubmitUser = submitId && !this.quote?.submittedByName
        const needsApproveUser = approveId && !this.quote?.approvedByName
        if (!needsSubmitUser && !needsApproveUser) return
        const { userService } = await import('../services/userService.js')
        const updates = {}
        if (needsSubmitUser) {
          try {
            const u = await userService.getUser(submitId)
            updates.submittedByName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id
          } catch {}
        }
        if (needsApproveUser) {
          try {
            const u = await userService.getUser(approveId)
            updates.approvedByName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id
          } catch {}
        }
        if (Object.keys(updates).length) {
          // Merge locally so UI shows names without another server write
          this.$emit('quote-updated', { ...this.quote, ...updates })
        }
      } catch (e) {
        console.warn('Failed to hydrate action user names', e)
      }
    },
    async hydrateCreatedByUser() {
      try {
        const createdId = this.quote?.createdById || this.quote?.createdBy
        if (!createdId || this.quote?.createdByName) return
        const { userService } = await import('../services/userService.js')
        const u = await userService.getUser(createdId)
        const createdByName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id
        this.$emit('quote-updated', { ...this.quote, createdByName })
      } catch (e) {
        console.warn('Failed to hydrate createdBy user name', e)
      }
    },
    openNameDialog() {
      if (!(this.quote?.status === 'Draft' || !this.quote?.status)) return
      this.editName = this.quote.name || ''
      this.showNameDialog = true
    },
    closeNameDialog() {
      this.showNameDialog = false
    },
    async saveName() {
      try {
        if (!this.editName || !this.editName.trim()) return
        this.savingName = true
        await quoteService.updateQuoteName(this.quote.id, this.editName.trim())
        const refreshed = await quoteService.getQuote(this.quote.id)
        this.$emit('quote-updated', refreshed)
        this.showNameDialog = false
      } catch (e) {
        console.error('Failed to update quote name:', e)
        alert('Failed to update name: ' + (e.message || 'Unknown error'))
      } finally {
        this.savingName = false
      }
    },
    openDeliveryInfoDialog() {
      this.showDeliveryInfoDialog = true
    },
    closeDeliveryInfoDialog() {
      this.showDeliveryInfoDialog = false
    },
    openAddressDialog() {
      if (this.productsReadOnly) return
      this.showAddressDialog = true
    },
    closeAddressDialog() {
      this.showAddressDialog = false
    },
    selectAddress(id) {
      if (this.productsReadOnly) return
      this.selectedAddressId = id
      this.onAddressChange()
      this.closeAddressDialog()
    },
    async loadDeliveryAddresses() {
      try {
        if (!this.customerId) return
        this.loadingAddresses = true
        const { deliveryAddressService } = await import('../services/deliveryAddressService.js')
        const result = await deliveryAddressService.listDeliveryAddresses(this.customerId)
        const activeList = Array.isArray(result) ? result : (result.results || [])
        // Ensure selected address appears even if inactive
        if (this.quote.deliveryAddressId) {
          try {
            const selectedAddr = await deliveryAddressService.getDeliveryAddress(this.quote.deliveryAddressId)
            const exists = activeList.some(a => a.id === selectedAddr.id)
            if (!exists && selectedAddr) {
              activeList.push(selectedAddr)
            }
          } catch (e) {
            console.warn('Could not hydrate selected delivery address:', e)
          }
        }
        this.deliveryAddresses = activeList
      } catch (e) {
        console.error('Failed to load delivery addresses', e)
        this.deliveryAddresses = []
      } finally {
        this.loadingAddresses = false
      }
    },

    async onAddressChange() {
      try {
        // update quote delivery address on change
        await quoteService.updateQuoteDeliveryAddress(this.quote.id, this.selectedAddressId)
        const updatedQuote = await quoteService.getQuote(this.quote.id)
        this.$emit('quote-updated', updatedQuote)
      } catch (e) {
        console.error('Failed to update quote delivery address', e)
        alert('Failed to update delivery address: ' + (e.message || 'Unknown error'))
      }
    },

    selectBoxType(type) {
      if (this.selectedBoxType !== type) {
        this.selectedBoxType = type
        // mimic native change
        this.onBoxTypeChange()
      }
    },
    async toggleProductsReadOnly() {
      if (!(this.quote?.status === 'Draft' || !this.quote?.status)) return
      if (!this.productsReadOnly) {
        // going into shipping mode; require address
        this.addressSubmitAttempted = true
        if (!this.selectedAddressId) {
          return
        }
      }
      this.productsReadOnly = !this.productsReadOnly
      
      if (this.productsReadOnly && this.selectedBoxType) {
        // If switching to read-only mode, calculate equipment boxes and delivery
        await this.calculateEquipmentBoxes()
        // Calculate delivery rates after equipment boxes are calculated
        if (this.equipmentBoxes.length > 0) {
          await this.calculateDeliveryRates()
        }
      } else if (!this.productsReadOnly) {
        // If switching back to editing mode, reset delivery info
        this.addressSubmitAttempted = false
        await this.resetDeliveryInfo()
      }
    },
    
    async loadCustomerPriceList() {
      try {
        const { priceListService } = await import('../services/priceListService.js')
        // Fetch all CPLs for this customer, then find the one matching the quote's CPL id
        if (this.customerId) {
          const lists = await priceListService.getCustomerPriceLists(this.customerId)
          const match = lists.find(l => l.id === this.quote.customerPriceListId)
          if (match) {
            this.customerPriceList = match
          } else {
            console.warn('Customer price list not found for quote. Falling back to empty priceListId')
            this.customerPriceList = { priceListId: '' }
          }
        } else {
          console.warn('No customerId provided to QuoteDetail; cannot resolve priceListId')
          this.customerPriceList = { priceListId: '' }
        }
      } catch (err) {
        console.error('Failed to load customer price list:', err)
        this.customerPriceList = { priceListId: '' }
      }
    },
    
    async loadQuoteProducts() {
      try {
        this.loadingProducts = true
        this.quoteProducts = await quoteService.getQuoteProducts(this.quote.id)
      } catch (err) {
        console.error('Failed to load quote products:', err)
      } finally {
        this.loadingProducts = false
      }

      try {
        this.productPrices = await productService.getProductPricesByPriceList(this.customerPriceList.priceListId)
      } catch (err) {
        console.error('Failed to load product prices:', err)
      }
    },
    
    async loadProductDetails() {
      try {
        const { productService } = await import('../services/productService.js')
        for (const quoteProduct of this.quoteProducts) {
          //const productPrice = this.productPrices.find(p => p.id === quoteProduct.productPriceId)

          if (!this.productDetails[quoteProduct.productId]) {
            try {
              this.productDetails[quoteProduct.productId] = await productService.getProduct(quoteProduct.productId)
            } catch (err) {
              console.error(`Failed to load product price ${quoteProduct.productId}:`, err)
            }
          }
        }
      } catch (err) {
        console.error('Failed to load product details:', err)
      }
    },
    
    async updateProductQuantity(productId, quantity) {
      try {
        // Update the backend
        await quoteService.updateQuoteProduct(productId, parseFloat(quantity))
        
        // Reload the quote products list to get updated computed fields
        await this.loadQuoteProducts()
        
        // Refresh quote totals
        const updatedQuote = await quoteService.getQuote(this.quote.id)
        this.$emit('quote-updated', updatedQuote)
      } catch (err) {
        console.error('Failed to update product quantity:', err)
      }
    },
    
    async removeProduct(productId) {
      if (!confirm('Are you sure you want to remove this product from the quote?')) {
        return
      }
      
      try {
        // Delete from backend
        await quoteService.deleteQuoteProduct(productId)
        
        // Reload the quote products list to get updated data
        await this.loadQuoteProducts()
        
        // Refresh quote totals
        const updatedQuote = await quoteService.getQuote(this.quote.id)
        this.$emit('quote-updated', updatedQuote)
      } catch (err) {
        console.error('Failed to remove product:', err)
      }
    },
    
    async deleteQuote() {
      if (!confirm('Are you sure you want to delete this quote? This action cannot be undone.')) {
        return
      }
      
      try {
        await quoteService.deleteQuote(this.quote.id)
        this.$emit('quote-deleted')
      } catch (err) {
        console.error('Failed to delete quote:', err)
      }
    },
    
    async handleProductAdded() {
      this.showAddProductModal = false
      await this.loadQuoteProducts()
      await this.loadProductDetails()
      // Refresh quote totals
      const updatedQuote = await quoteService.getQuote(this.quote.id)
      this.$emit('quote-updated', updatedQuote)
    },
    
    async loadEquipmentBoxes() {
      try {
        this.loadingEquipmentBoxes = true
        const { equipmentBoxService } = await import('../services/equipmentBoxService.js')
        const response = await equipmentBoxService.listQuoteEquipmentBoxes(this.quote.id)
        this.equipmentBoxes = response.results || []
        
        // Load equipment box details for each equipment box
        for (const equipmentBox of this.equipmentBoxes) {
          if (!this.equipmentBoxDetails[equipmentBox.equipmentBoxId]) {
            try {
              this.equipmentBoxDetails[equipmentBox.equipmentBoxId] = await equipmentBoxService.getEquipmentBox(equipmentBox.equipmentBoxId)
            } catch (err) {
              console.error(`Failed to load equipment box details ${equipmentBox.equipmentBoxId}:`, err)
            }
          }
        }
      } catch (err) {
        console.error('Failed to load equipment boxes:', err)
        this.equipmentBoxes = []
      } finally {
        this.loadingEquipmentBoxes = false
      }
    },
    
    async onBoxTypeChange() {
      if (!this.selectedBoxType) {
        // Reset delivery info when no box type is selected
        await this.resetDeliveryInfo()
      } else {
        // Calculate equipment boxes for selected type
        await this.calculateEquipmentBoxes()
        // Calculate delivery rates after equipment boxes are calculated
        if (this.equipmentBoxes.length > 0) {
          await this.calculateDeliveryRates()
        }
      }
    },
    
    async resetDeliveryInfo() {
      try {
        this.loading = true
        const { equipmentBoxService } = await import('../services/equipmentBoxService.js')
        await equipmentBoxService.resetDeliveryInfo(this.quote.id)
        
        // Reset local state
        this.equipmentBoxes = []
        this.deliveryRates = null
        this.deliveryRatesError = null
        
        // Refresh quote data to get updated totals
        await this.refreshQuoteData()
      } catch (err) {
        console.error('Failed to reset delivery info:', err)
        alert('Failed to reset delivery info: ' + err.message)
      } finally {
        this.loading = false
      }
    },
    
    async calculateEquipmentBoxes() {
      if (!this.selectedBoxType) return
      
      try {
        this.loading = true
        const { equipmentBoxService } = await import('../services/equipmentBoxService.js')
        await equipmentBoxService.calculateEquipmentBoxes(this.quote.id, this.selectedBoxType)
        await this.loadEquipmentBoxes()
        
        // Refresh quote data to get updated totals after equipment boxes calculation
        await this.refreshQuoteData()
      } catch (err) {
        console.error('Failed to calculate equipment boxes:', err)
        alert('Failed to calculate equipment boxes: ' + err.message)
      } finally {
        this.loading = false
      }
    },
    
    formatDate(dateString) {
      if (!dateString) return '—'
      const d = new Date(dateString)
      const day = String(d.getDate()).padStart(2, '0')
      const month = d.toLocaleString('en-GB', { month: 'short' })
      const year = d.getFullYear()
      const hours = String(d.getHours()).padStart(2, '0')
      const minutes = String(d.getMinutes()).padStart(2, '0')
      return `${day} ${month} ${year} ${hours}:${minutes}`
    },
    
    formatCurrency(amount) {
      return parseFloat(amount).toLocaleString('en-ZA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    },
    
    formatVolume(volume) {
      if (!volume) return 'N/A'
      return `${parseFloat(volume).toFixed(0)} cm³`
    },
    
    formatDimensions(equipmentBox) {
      if (!equipmentBox) return 'N/A'
      const { lengthInCm, widthInCm, heightInCm } = equipmentBox
      if (!lengthInCm || !widthInCm || !heightInCm) return 'N/A'
      return `${parseFloat(lengthInCm).toFixed(0)} × ${parseFloat(widthInCm).toFixed(0)} × ${parseFloat(heightInCm).toFixed(0)} cm`
    },
    
    formatWeight(weightInGrams) {
      if (!weightInGrams || weightInGrams === 0) return '0 kg'
      
      const weightInKg = weightInGrams / 1000
      if (weightInKg >= 1) {
        return `${weightInKg.toFixed(2)} kg`
      } else {
        return `${weightInGrams.toFixed(0)} g`
      }
    },
    
    showImagePreview(productId, event) {
      const product = this.productDetails[productId]
      if (product?.image?.url) {
        // Calculate initial position with offset to avoid going off-screen
        const offsetX = 10
        const offsetY = 10
        const previewWidth = 250 // increased ~25% for larger preview
        const previewHeight = 250 // increased ~25% for larger preview
        
        let x = event.clientX + offsetX
        let y = event.clientY + offsetY
        
        // Adjust if preview would go off the right edge
        if (x + previewWidth > window.innerWidth) {
          x = event.clientX - previewWidth - offsetX
        }
        
        // Adjust if preview would go off the bottom edge
        if (y + previewHeight > window.innerHeight) {
          y = event.clientY - previewHeight - offsetY
        }
        
        this.imagePreview = {
          show: true,
          src: product.image.url,
          alt: product.name || 'Product',
          x: x,
          y: y
        }
      }
    },
    
    updateImagePreviewPosition(event) {
      if (this.imagePreview.show) {
        // Calculate position with offset to avoid going off-screen
        const offsetX = 10
        const offsetY = 10
        const previewWidth = 250 // match increased preview size
        const previewHeight = 250 // match increased preview size
        
        let x = event.clientX + offsetX
        let y = event.clientY + offsetY
        
        // Adjust if preview would go off the right edge
        if (x + previewWidth > window.innerWidth) {
          x = event.clientX - previewWidth - offsetX
        }
        
        // Adjust if preview would go off the bottom edge
        if (y + previewHeight > window.innerHeight) {
          y = event.clientY - previewHeight - offsetY
        }
        
        this.imagePreview.x = x
        this.imagePreview.y = y
      }
    },
    
    hideImagePreview() {
      this.imagePreview.show = false
    },

    showBoxImagePreview(equipmentBoxId, event) {
      const box = this.equipmentBoxDetails[equipmentBoxId]
      if (box?.image?.url) {
        const offsetX = 10
        const offsetY = 10
        const previewWidth = 250
        const previewHeight = 250
        let x = event.clientX + offsetX
        let y = event.clientY + offsetY
        if (x + previewWidth > window.innerWidth) {
          x = event.clientX - previewWidth - offsetX
        }
        if (y + previewHeight > window.innerHeight) {
          y = event.clientY - previewHeight - offsetY
        }
        this.imagePreview = {
          show: true,
          src: box.image.url,
          alt: box.name || 'Equipment Box',
          x,
          y
        }
      }
    },
    
    resetDeliveryRates() {
      // Reset delivery rates when quote parameters change
      this.deliveryRates = null
      this.deliveryRatesError = null
      this.loadingDeliveryRates = false
    },
    
    async calculateDeliveryRates() {
      if (!this.selectedBoxType || this.equipmentBoxes.length === 0) {
        this.deliveryRatesError = 'Please calculate equipment boxes first before calculating delivery rates.'
        return
      }
      
      this.loadingDeliveryRates = true
      this.deliveryRatesError = null
      this.deliveryRates = null
      
      try {
        const response = await deliveryService.calculateDelivery(this.quote.id)
        
        // Extract the charged weight from the cheapest rate (first in availableRates)
        const chargedWeight = response.availableRates && response.availableRates.length > 0 
          ? response.availableRates[0].weights.chargedWeight 
          : null
        
        this.deliveryRates = {
          ...response,
          chargedWeight: chargedWeight
        }
        
        // Refresh quote data to get updated totals after successful delivery calculation
        await this.refreshQuoteData()
      } catch (error) {
        console.error('Failed to calculate delivery rates:', error)
        this.deliveryRatesError = error.message || 'Failed to calculate delivery rates'
      } finally {
        this.loadingDeliveryRates = false
      }
    },
    
    formatDeliveryDate(dateString) {
      if (!dateString) return 'N/A'
      
      try {
        const date = new Date(dateString)
        const day = String(date.getDate()).padStart(2, '0')
        const month = date.toLocaleString('en-GB', { month: 'short' })
        const year = date.getFullYear()
        return `${day} ${month} ${year}`
      } catch (error) {
        console.error('Error formatting delivery date:', error)
        return 'Invalid date'
      }
    },

    formatQuoteStatus(status) {
      if (!status) return 'Draft'
      if (status === 'Submitted') return 'Submitted'
      if (status === 'Approved') return 'Approved'
      return 'Draft'
    },

    async refreshQuoteData() {
      try {
        // Refresh the quote data from the backend
        const refreshedQuote = await quoteService.getQuote(this.quote.id)
        
        // Update local quote data
        
        // Emit the updated quote to parent component
        this.$emit('quote-updated', refreshedQuote)
        
        // Ensure UI updates after quote data change
        await this.$nextTick()
        
        console.log('Quote data refreshed successfully')
      } catch (error) {
        console.error('Failed to refresh quote data:', error)
        // Don't show alert here as it might be too intrusive
        // The quote will still work with the existing data
      }
    },

    initializeBoxType() {
      // Set the box type based on the quote's boxType field
      if (this.quote.boxType) {
        this.selectedBoxType = this.quote.boxType
        console.log('Initialized box type from quote:', this.quote.boxType)
      }
    },

    checkExistingDeliveryDetails() {
      // Check if the quote already has delivery details set
      if (this.quote.deliveryService && this.quote.totalDeliveryFees && this.quote.totalDeliveryFees > 0) {
        // Hydrate the delivery rates with existing data
        this.deliveryRates = {
          selectedDeliveryService: this.quote.deliveryService,
          selectedDeliveryFees: this.quote.totalDeliveryFees,
          // We'll need to calculate these from equipment boxes if available
          totalParcels: this.equipmentBoxes.length > 0 ? this.equipmentBoxes.reduce((sum, box) => sum + box.quantity, 0) : 0,
          totalWeightKg: this.totalShipmentWeight / 1000, // Convert from grams to kg
          totalVolumeCm3: this.equipmentBoxes.length > 0 ? this.equipmentBoxes.reduce((sum, box) => {
            const equipmentBoxDetail = this.equipmentBoxDetails[box.equipmentBoxId]
            if (equipmentBoxDetail) {
              const volume = (equipmentBoxDetail.lengthInCm * equipmentBoxDetail.widthInCm * equipmentBoxDetail.heightInCm) * box.quantity
              return sum + volume
            }
            return sum
          }, 0) : 0
          // Note: chargedWeight is only available after fresh delivery calculation
          // For existing delivery details, we don't have the charged weight from the API
        }
        console.log('Hydrated existing delivery details:', this.deliveryRates)
      } else {
        console.log('No existing delivery details found')
      }
    },

    async submitQuote() {
      try {
        this.submittingQuote = true
        await quoteService.submitQuote(this.quote.id)
        const refreshed = await quoteService.getQuote(this.quote.id)
        // Lock the UI by reflecting submitted status
        this.$emit('quote-updated', refreshed)
        this.productsReadOnly = true
        this.showAddProductModal = false
      } catch (err) {
        console.error('Failed to submit quote:', err)
        alert('Failed to submit quote: ' + (err.message || 'Unknown error'))
      } finally {
        this.submittingQuote = false
      }
    }
  }
}
</script>
