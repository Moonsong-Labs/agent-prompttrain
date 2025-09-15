#!/bin/bash

# Script to replace domain with train-id throughout the codebase
# This script performs systematic replacements but should be reviewed before committing

echo "Starting domain to train-id migration..."

# Backup important files first
echo "Creating backups..."
mkdir -p .migration-backup
cp -r services/proxy/src .migration-backup/proxy-src-backup
cp -r services/dashboard/src .migration-backup/dashboard-src-backup
cp -r packages/shared/src .migration-backup/shared-src-backup

# Function to replace in files
replace_in_files() {
    local pattern="$1"
    local replacement="$2"
    local file_pattern="$3"
    
    echo "Replacing '$pattern' with '$replacement' in $file_pattern files..."
    find . -name "$file_pattern" -type f \
        -not -path "./node_modules/*" \
        -not -path "./.migration-backup/*" \
        -not -path "./.git/*" \
        -not -path "./test-wildcard-bug.ts" \
        -exec sed -i "s/$pattern/$replacement/g" {} \;
}

# TypeScript/JavaScript replacements
echo "Updating TypeScript/JavaScript files..."

# Replace domain variable names with trainId
replace_in_files "domain:" "trainId:" "*.ts"
replace_in_files "domain," "trainId," "*.ts"
replace_in_files "\.domain" ".trainId" "*.ts"
replace_in_files "domain\?" "trainId?" "*.ts"
replace_in_files "'domain'" "'trainId'" "*.ts"
replace_in_files '"domain"' '"trainId"' "*.ts"
replace_in_files "domain =" "trainId =" "*.ts"
replace_in_files "const domain" "const trainId" "*.ts"
replace_in_files "let domain" "let trainId" "*.ts"
replace_in_files "var domain" "var trainId" "*.ts"

# Update SQL queries 
echo "Updating SQL queries in TypeScript files..."
replace_in_files "r\.domain" "r.train_id" "*.ts"
replace_in_files "api_requests\.domain" "api_requests.train_id" "*.ts"
replace_in_files "SELECT domain" "SELECT train_id" "*.ts"
replace_in_files "WHERE domain" "WHERE train_id" "*.ts"
replace_in_files "GROUP BY domain" "GROUP BY train_id" "*.ts"
replace_in_files "ORDER BY domain" "ORDER BY train_id" "*.ts"

# Update function and method names
replace_in_files "domainExtractor" "trainIdExtractor" "*.ts"
replace_in_files "DomainRateLimiter" "TrainIdRateLimiter" "*.ts"
replace_in_files "domainStore" "trainIdStore" "*.ts"
replace_in_files "domainMapping" "trainIdMapping" "*.ts"
replace_in_files "isPersonalDomain" "isDefaultTrainId" "*.ts"
replace_in_files "authenticateNonPersonalDomain" "authenticateNonDefault" "*.ts"
replace_in_files "authenticatePersonalDomain" "authenticateDefault" "*.ts"
replace_in_files "resolveCredentialPath" "mapTrainIdToAccount" "*.ts"

# Update comments
replace_in_files "domain-based" "train-id-based" "*.ts"
replace_in_files "Domain-based" "Train-ID-based" "*.ts"
replace_in_files "per domain" "per train-id" "*.ts"
replace_in_files "per-domain" "per-train-id" "*.ts"

# SQL files
echo "Updating SQL files..."
replace_in_files "domain VARCHAR" "train_id VARCHAR" "*.sql"
replace_in_files "idx_requests_domain" "idx_requests_train_id" "*.sql"
replace_in_files "idx_api_requests_domain" "idx_api_requests_train_id" "*.sql"

# Test files special handling
echo "Updating test files..."
replace_in_files "mockDomain" "mockTrainId" "*.test.ts"
replace_in_files "testDomain" "testTrainId" "*.test.ts"
replace_in_files "expectedDomain" "expectedTrainId" "*.test.ts"

# Dashboard components
echo "Updating dashboard components..."
replace_in_files "domain\}" "{trainId}" "*.tsx"
replace_in_files "domain:" "trainId:" "*.tsx"
replace_in_files "\.domain" ".trainId" "*.tsx"

# Documentation files
echo "Updating documentation..."
replace_in_files "domain" "train-id" "*.md"
replace_in_files "Domain" "Train-ID" "*.md"
replace_in_files "DOMAIN" "TRAIN_ID" "*.md"
replace_in_files "domains" "train-ids" "*.md"
replace_in_files "Domains" "Train-IDs" "*.md"

# Environment variable documentation
replace_in_files "Host header" "X-TRAIN-ID header" "*.md"
replace_in_files "host header" "X-TRAIN-ID header" "*.md"

echo "Migration script completed!"
echo "Please review changes carefully before committing."
echo "Backups are stored in .migration-backup/"
echo ""
echo "Next steps:"
echo "1. Review all changes with 'git diff'"
echo "2. Run 'bun test' to ensure tests pass"
echo "3. Run 'bun run typecheck' to check for type errors"
echo "4. Test the application manually"
echo "5. Commit changes if everything works"