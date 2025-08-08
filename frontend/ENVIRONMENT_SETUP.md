# Environment Setup Guide

This guide explains how to properly configure environment variables for different environments (local development vs production).

## Environment File Hierarchy

Vite follows this priority order for environment files (highest to lowest):

1. `.env.local` - Local development (gitignored)
2. `.env.production` - Production builds
3. `.env` - General environment variables
4. `.env.example` - Template file (committed to git)

## File Setup

### 1. `.env.local` (Local Development)
```bash
# Local Development Environment Variables
# This file is for local development only
# Copy this to .env.local and modify as needed

# API Configuration
VITE_API_URL=http://localhost:8000
```

**Usage**: This file is automatically loaded during `npm run dev`
**Git**: Should be in `.gitignore` (contains local-specific settings)

### 2. `.env.production` (Production Builds)
```bash
# Production Environment Variables
# This file is for production builds
# These values will be overridden by Vercel environment variables

# API Configuration
VITE_API_URL=https://api.thecreatespace.co.za
```

**Usage**: This file is automatically loaded during `npm run build`
**Git**: Can be committed (contains fallback values)

### 3. `.env.example` (Template)
```bash
# Example Environment Variables
# Copy this file to .env.local for local development

# API Configuration
VITE_API_URL=http://localhost:8000
```

**Usage**: Template for developers to copy and customize
**Git**: Should be committed (serves as documentation)

## Setup Instructions

### For Local Development

1. **Copy the example file**:
   ```bash
   cp .env.example .env.local
   ```

2. **Modify `.env.local`** for your local setup:
   ```bash
   # Edit .env.local with your local API URL
   VITE_API_URL=http://localhost:8000
   ```

3. **Start development server**:
   ```bash
   npm run dev
   ```

### For Production (Vercel)

1. **Environment Variables in Vercel**:
   - Go to Vercel Dashboard → Project Settings → Environment Variables
   - Add `VITE_API_URL` with your production API URL
   - Set for Production, Preview, and Development environments

2. **Deploy**:
   ```bash
   # Vercel will automatically use the environment variables
   # The .env.production file serves as a fallback
   ```

## Environment Variable Priority

When building for production, Vite uses this priority:

1. **Vercel Environment Variables** (highest priority)
2. **`.env.production`** (fallback if Vercel vars not set)
3. **`.env`** (general fallback)

## Verification

### Local Development
```bash
# Check that local environment is loaded
npm run dev
# Should use http://localhost:8000
```

### Production Build
```bash
# Check production build
npm run build
# Should use production API URL from Vercel or .env.production
```

### Testing Environment Variables
```bash
# Test with specific environment variable
VITE_API_URL=https://test-api.com npm run build
```

## Troubleshooting

### Issue: Local development not using .env.local
**Solution**: Ensure `.env.local` exists and has correct format:
```bash
VITE_API_URL=http://localhost:8000
```

### Issue: Production build using wrong API URL
**Solution**: 
1. Check Vercel environment variables
2. Verify `.env.production` has correct fallback values
3. Redeploy after setting environment variables

### Issue: Environment variables not loading
**Solution**: 
1. Ensure variable names start with `VITE_`
2. Restart development server after changes
3. Check file syntax (no spaces around `=`)

## Security Best Practices

1. **Never commit sensitive data**:
   - `.env.local` should be in `.gitignore`
   - Use `.env.example` for templates

2. **Use environment-specific files**:
   - `.env.local` for local development
   - `.env.production` for production builds

3. **Validate environment variables**:
   - Check that required variables are set
   - Use fallback values where appropriate

## File Structure

```
frontend/
├── .env.example          # Template (committed)
├── .env.local           # Local development (gitignored)
├── .env.production      # Production fallback (committed)
├── src/
│   └── config/
│       └── api.js       # Uses import.meta.env.VITE_API_URL
└── vite.config.js       # Vite configuration
```

## Commands Reference

```bash
# Local development (uses .env.local)
npm run dev

# Production build (uses .env.production + Vercel env vars)
npm run build

# Preview build (uses .env.production + Vercel env vars)
npm run preview
```
