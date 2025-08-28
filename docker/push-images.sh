#!/bin/bash
# Push Agent PromptTrain Docker images to Docker Hub with multi-arch manifest support

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Parse command line arguments
TAG="${1:-latest}"
PUSH_LATEST="${2:-yes}"

# Show usage if requested
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: $0 [TAG] [PUSH_LATEST]"
    echo "  TAG: Docker image tag to push (default: latest)"
    echo "  PUSH_LATEST: Also push 'latest' tag when pushing version tag (yes/no, default: yes)"
    echo ""
    echo "This script now supports multi-architecture images."
    echo "Use docker/build-images.sh with BUILD_ACTION=push to build and push."
    echo ""
    echo "Examples:"
    echo "  $0                  # Push images with 'latest' tag"
    echo "  $0 v9               # Push images with 'v9' tag and 'latest'"
    echo "  $0 v9 no            # Push images with 'v9' tag only"
    echo ""
    echo "To build and push multi-arch:"
    echo "  BUILD_ACTION=push ./docker/build-images.sh [TAG]"
    echo ""
    echo "Note: You must be logged in to Docker Hub first:"
    echo "  docker login"
    exit 0
fi

echo -e "${BLUE}Pushing Agent PromptTrain Docker Images...${NC}"
echo -e "${YELLOW}Tag: ${TAG}${NC}"

# Check if user is logged in to Docker Hub
if ! docker info 2>/dev/null | grep -q "Username"; then
    echo -e "${YELLOW}Warning: You may not be logged in to Docker Hub${NC}"
    echo -e "Run '${BLUE}docker login${NC}' first if push fails"
    echo ""
fi

# Function to check if image exists locally or as manifest
check_image_exists() {
    local image=$1
    if docker image inspect "$image" &>/dev/null; then
        return 0
    elif docker buildx imagetools inspect "$image" &>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Function to push image or display error with helpful message
push_image() {
    local image=$1
    local service=$2
    
    echo -e "\n${BLUE}Pushing ${service} Service...${NC}"
    
    # Check if image exists
    if ! check_image_exists "$image"; then
        echo -e "${YELLOW}Warning: Image ${image} not found locally${NC}"
        echo -e "${YELLOW}For multi-arch images, use: BUILD_ACTION=push ./docker/build-images.sh ${TAG}${NC}"
        echo -e "${YELLOW}Attempting push anyway (may work if already in registry)...${NC}"
    fi
    
    # Try to push
    if docker push "$image" 2>/dev/null; then
        echo -e "${GREEN}✓ ${service} image pushed successfully${NC}"
        return 0
    else
        # If regular push fails, it might be a multi-arch manifest
        echo -e "${YELLOW}Standard push failed, checking for multi-arch manifest...${NC}"
        if docker buildx imagetools inspect "$image" &>/dev/null; then
            echo -e "${GREEN}✓ ${service} multi-arch manifest already exists in registry${NC}"
            return 0
        else
            echo -e "${RED}✗ Failed to push ${service} image${NC}"
            echo -e "${YELLOW}Hint: For multi-arch builds, use:${NC}"
            echo -e "${BLUE}  BUILD_ACTION=push ./docker/build-images.sh ${TAG}${NC}"
            return 1
        fi
    fi
}

# Push proxy image
if ! push_image "moonsonglabs/agent-prompttrain-proxy:${TAG}" "Proxy"; then
    exit 1
fi

# Push dashboard image
if ! push_image "moonsonglabs/agent-prompttrain-dashboard:${TAG}" "Dashboard"; then
    exit 1
fi

# Push all-in-one image
if ! push_image "moonsonglabs/agent-prompttrain-all-in:${TAG}" "All-in-One"; then
    exit 1
fi

# Also push latest tags if requested and not already pushing latest
if [ "$TAG" != "latest" ] && [ "$PUSH_LATEST" = "yes" ]; then
    echo -e "\n${BLUE}Also pushing 'latest' tags...${NC}"
    
    if ! push_image "moonsonglabs/agent-prompttrain-proxy:latest" "Proxy (latest)"; then
        exit 1
    fi
    
    if ! push_image "moonsonglabs/agent-prompttrain-dashboard:latest" "Dashboard (latest)"; then
        exit 1
    fi
    
    if ! push_image "moonsonglabs/agent-prompttrain-all-in:latest" "All-in-One (latest)"; then
        exit 1
    fi
fi

echo -e "\n${GREEN}Push completed successfully!${NC}"

# Check and display manifest information if available
echo -e "\n${BLUE}Checking multi-architecture support...${NC}"
for image in proxy dashboard all-in; do
    full_image="moonsonglabs/agent-prompttrain-${image}:${TAG}"
    if docker buildx imagetools inspect "$full_image" &>/dev/null; then
        echo -e "${GREEN}✓ ${image} supports multiple architectures:${NC}"
        docker buildx imagetools inspect "$full_image" 2>/dev/null | grep -E "Platform:|linux/" | head -5
    else
        echo -e "${YELLOW}  ${image}: Single architecture or not accessible${NC}"
    fi
done

echo -e "\nImages available at:"
echo -e "  ${YELLOW}https://hub.docker.com/r/moonsonglabs/agent-prompttrain-proxy${NC}"
echo -e "  ${YELLOW}https://hub.docker.com/r/moonsonglabs/agent-prompttrain-dashboard${NC}"
echo -e "  ${YELLOW}https://hub.docker.com/r/moonsonglabs/agent-prompttrain-all-in${NC}"

echo -e "\nTo pull and run:"
echo -e "  ${BLUE}# All-in-One (recommended for demos)${NC}"
echo -e "  ${BLUE}docker pull moonsonglabs/agent-prompttrain-all-in:${TAG}${NC}"
echo -e "  ${BLUE}docker run -d -p 3000:3000 -p 3001:3001 moonsonglabs/agent-prompttrain-all-in:${TAG}${NC}"
echo -e "  ${BLUE}# Or pull services separately:${NC}"
echo -e "  ${BLUE}docker pull moonsonglabs/agent-prompttrain-proxy:${TAG}${NC}"
echo -e "  ${BLUE}docker pull moonsonglabs/agent-prompttrain-dashboard:${TAG}${NC}"