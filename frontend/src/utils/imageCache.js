/**
 * Image Cache Utility
 *
 * Caches image blob data in memory to avoid re-downloading images
 * even when S3 presigned URLs change on each API request.
 *
 * The cache uses the image's unique identifier (productId, equipmentBoxId)
 * as the key and stores the blob URL created from the downloaded image data.
 */

class ImageCache {
  constructor() {
    // Store blob URLs by unique identifier
    this.cache = new Map()
    // Store original URLs to detect changes
    this.urlMap = new Map()
  }

  /**
   * Get a cached image URL or fetch and cache it
   * @param {string} id - Unique identifier (productId, equipmentBoxId, etc.)
   * @param {string} url - The image URL (may be a presigned URL that changes)
   * @returns {Promise<string>} - A stable blob URL or the original URL if caching fails
   */
  async get(id, url) {
    if (!id || !url) {
      return url
    }

    // If we have a cached blob URL for this ID, return it
    if (this.cache.has(id)) {
      return this.cache.get(id)
    }

    try {
      // Fetch the image as a blob
      const response = await fetch(url)
      if (!response.ok) {
        console.warn(`Failed to fetch image for caching: ${url}`)
        return url
      }

      const blob = await response.blob()

      // Create a blob URL that won't expire
      const blobUrl = URL.createObjectURL(blob)

      // Cache the blob URL
      this.cache.set(id, blobUrl)
      this.urlMap.set(id, url)

      return blobUrl
    } catch (error) {
      console.warn(`Error caching image for ${id}:`, error)
      // Fall back to original URL if caching fails
      return url
    }
  }

  /**
   * Clear a specific cached image or all cached images
   * @param {string} id - Optional ID to clear specific image
   */
  clear(id = null) {
    if (id) {
      // Revoke the blob URL to free memory
      const blobUrl = this.cache.get(id)
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
      this.cache.delete(id)
      this.urlMap.delete(id)
    } else {
      // Clear all cached images
      for (const blobUrl of this.cache.values()) {
        URL.revokeObjectURL(blobUrl)
      }
      this.cache.clear()
      this.urlMap.clear()
    }
  }

  /**
   * Get cache statistics
   * @returns {object} - Cache size and entry count
   */
  getStats() {
    return {
      entryCount: this.cache.size,
      ids: Array.from(this.cache.keys())
    }
  }
}

// Export a singleton instance
export const imageCache = new ImageCache()
