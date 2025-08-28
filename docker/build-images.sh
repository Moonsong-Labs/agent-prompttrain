#!/bin/bash
# Build both proxy and dashboard Docker images with multi-platform support

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Parse command line arguments
TAG="${1:-latest}"
PLATFORMS="${BUILD_PLATFORMS:-${PLATFORMS:-linux/amd64,linux/arm64}}"
BUILD_ACTION="${BUILD_ACTION:-load}"  # "load" for local, "push" for registry

# Show usage if requested
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: $0 [TAG]"
    echo "  TAG: Additional version tag to apply (optional)"
    echo ""
    echo "Environment Variables:"
    echo "  BUILD_PLATFORMS: Target platforms (default: linux/amd64,linux/arm64)"
    echo "  BUILD_ACTION: 'load' for local or 'push' for registry (default: load)"
    echo ""
    echo "Build Process:"
    echo "  - Always builds images with 'latest' tag"
    echo "  - If TAG is provided, also tags images with that version"
    echo "  - Uses Docker buildx for multi-platform support"
    echo ""
    echo "Examples:"
    echo "  $0          # Builds with 'latest' tag only"
    echo "  $0 v9       # Builds with 'latest' and tags as 'v9'"
    echo "  BUILD_PLATFORMS=linux/amd64 $0  # Build for amd64 only"
    echo "  BUILD_ACTION=push $0  # Build and push to registry"
    exit 0
fi

echo -e "${BLUE}Building Agent PromptTrain Docker Images...${NC}"
if [ "$TAG" != "latest" ]; then
    echo -e "${YELLOW}Will tag images as: latest and ${TAG}${NC}"
else
    echo -e "${YELLOW}Building with tag: latest${NC}"
fi
echo -e "${YELLOW}Target platforms: ${PLATFORMS}${NC}"

# Get the script directory and project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Function to check if buildx is available and set up
setup_buildx() {
    # Check if docker buildx is available
    if ! docker buildx version &>/dev/null; then
        echo -e "${RED}Docker buildx is not available. Please update Docker.${NC}"
        exit 1
    fi

    # Check if we have a builder or create one
    BUILDER_NAME="agent-prompttrain-builder"
    if ! docker buildx ls | grep -q "$BUILDER_NAME"; then
        echo -e "${YELLOW}Creating buildx builder: ${BUILDER_NAME}${NC}"
        docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
    else
        echo -e "${YELLOW}Using existing buildx builder: ${BUILDER_NAME}${NC}"
        docker buildx use "$BUILDER_NAME"
    fi

    # Ensure the builder is bootstrapped
    docker buildx inspect --bootstrap >/dev/null 2>&1
}

# Get current platform
CURRENT_PLATFORM=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null || echo "linux/amd64")

# Function to determine build command based on platform count and action
get_build_command() {
    local dockerfile=$1
    local image_name=$2
    local tag=$3
    
    # Count platforms
    IFS=',' read -ra PLATFORM_ARRAY <<< "$PLATFORMS"
    PLATFORM_COUNT=${#PLATFORM_ARRAY[@]}
    
    if [ "$PLATFORM_COUNT" -eq 1 ] && [ "$PLATFORMS" = "$CURRENT_PLATFORM" ] && [ "$BUILD_ACTION" = "load" ]; then
        # Single platform matching current arch - can use regular docker build
        >&2 echo -e "${YELLOW}Building for current platform only, using standard docker build${NC}"
        echo "docker build -f $dockerfile -t ${image_name}:${tag} ."
    elif [ "$BUILD_ACTION" = "push" ]; then
        # Multi-platform with push
        echo "docker buildx build --platform $PLATFORMS --push -f $dockerfile -t ${image_name}:${tag} ."
    elif [ "$PLATFORM_COUNT" -eq 1 ]; then
        # Single platform with buildx (can use --load)
        echo "docker buildx build --platform $PLATFORMS --load -f $dockerfile -t ${image_name}:${tag} ."
    else
        # Multi-platform without push (can't use --load)
        >&2 echo -e "${YELLOW}Warning: Multi-platform builds cannot be loaded locally. Build will be cached only.${NC}"
        >&2 echo -e "${YELLOW}To load locally, use: BUILD_PLATFORMS=linux/amd64 $0${NC}"
        >&2 echo -e "${YELLOW}To push to registry, use: BUILD_ACTION=push $0${NC}"
        echo "docker buildx build --platform $PLATFORMS -f $dockerfile -t ${image_name}:${tag} ."
    fi
}

# Set up buildx if needed
if [ "$PLATFORMS" != "$CURRENT_PLATFORM" ] || [ "$BUILD_ACTION" = "push" ]; then
    setup_buildx
fi

# Build proxy image (always build as latest first)
echo -e "\n${BLUE}Building Proxy Service...${NC}"
BUILD_CMD=$(get_build_command "docker/proxy/Dockerfile" "moonsonglabs/agent-prompttrain-proxy" "latest")
$BUILD_CMD
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Proxy image built successfully${NC}"
    # Tag with specific version if provided and loaded locally
    if [ "$TAG" != "latest" ] && [ "$BUILD_ACTION" = "load" ]; then
        docker tag moonsonglabs/agent-prompttrain-proxy:latest moonsonglabs/agent-prompttrain-proxy:${TAG}
        echo -e "${GREEN}✓ Also tagged as '${TAG}'${NC}"
    elif [ "$TAG" != "latest" ] && [ "$BUILD_ACTION" = "push" ]; then
        # Build and push with version tag
        BUILD_CMD=$(get_build_command "docker/proxy/Dockerfile" "moonsonglabs/agent-prompttrain-proxy" "$TAG")
        $BUILD_CMD
        echo -e "${GREEN}✓ Also pushed as '${TAG}'${NC}"
    fi
else
    echo -e "${RED}✗ Failed to build proxy image${NC}"
    exit 1
fi

# Build dashboard image (always build as latest first)
echo -e "\n${BLUE}Building Dashboard Service...${NC}"
BUILD_CMD=$(get_build_command "docker/dashboard/Dockerfile" "moonsonglabs/agent-prompttrain-dashboard" "latest")
$BUILD_CMD
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Dashboard image built successfully${NC}"
    # Tag with specific version if provided and loaded locally
    if [ "$TAG" != "latest" ] && [ "$BUILD_ACTION" = "load" ]; then
        docker tag moonsonglabs/agent-prompttrain-dashboard:latest moonsonglabs/agent-prompttrain-dashboard:${TAG}
        echo -e "${GREEN}✓ Also tagged as '${TAG}'${NC}"
    elif [ "$TAG" != "latest" ] && [ "$BUILD_ACTION" = "push" ]; then
        # Build and push with version tag
        BUILD_CMD=$(get_build_command "docker/dashboard/Dockerfile" "moonsonglabs/agent-prompttrain-dashboard" "$TAG")
        $BUILD_CMD
        echo -e "${GREEN}✓ Also pushed as '${TAG}'${NC}"
    fi
else
    echo -e "${RED}✗ Failed to build dashboard image${NC}"
    exit 1
fi

# Build all-in-one image (always build as latest first)
echo -e "\n${BLUE}Building All-in-One Service...${NC}"
BUILD_CMD=$(get_build_command "docker/all-in/agent-prompttrain-all-in.Dockerfile" "moonsonglabs/agent-prompttrain-all-in" "latest")
$BUILD_CMD
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ All-in-One image built successfully${NC}"
    # Tag with specific version if provided and loaded locally
    if [ "$TAG" != "latest" ] && [ "$BUILD_ACTION" = "load" ]; then
        docker tag moonsonglabs/agent-prompttrain-all-in:latest moonsonglabs/agent-prompttrain-all-in:${TAG}
        echo -e "${GREEN}✓ Also tagged as '${TAG}'${NC}"
    elif [ "$TAG" != "latest" ] && [ "$BUILD_ACTION" = "push" ]; then
        # Build and push with version tag
        BUILD_CMD=$(get_build_command "docker/all-in/agent-prompttrain-all-in.Dockerfile" "moonsonglabs/agent-prompttrain-all-in" "$TAG")
        $BUILD_CMD
        echo -e "${GREEN}✓ Also pushed as '${TAG}'${NC}"
    fi
else
    echo -e "${RED}✗ Failed to build all-in-one image${NC}"
    exit 1
fi

# Show image sizes (only if loaded locally)
if [ "$BUILD_ACTION" = "load" ]; then
    echo -e "\n${BLUE}Image Sizes:${NC}"
    docker images | grep -E "agent-prompttrain-(proxy|dashboard|all-in)|REPOSITORY" | grep -E "${TAG}|REPOSITORY" | head -7
fi

echo -e "\n${GREEN}Build completed successfully!${NC}"
echo -e "\nImages built for platforms: ${YELLOW}${PLATFORMS}${NC}"
echo -e "\nImages:"
echo -e "  ${YELLOW}moonsonglabs/agent-prompttrain-proxy:latest${NC}"
echo -e "  ${YELLOW}moonsonglabs/agent-prompttrain-dashboard:latest${NC}"
echo -e "  ${YELLOW}moonsonglabs/agent-prompttrain-all-in:latest${NC}"

if [ "$TAG" != "latest" ]; then
    echo -e "\nAlso tagged as:"
    echo -e "  ${YELLOW}moonsonglabs/agent-prompttrain-proxy:${TAG}${NC}"
    echo -e "  ${YELLOW}moonsonglabs/agent-prompttrain-dashboard:${TAG}${NC}"
    echo -e "  ${YELLOW}moonsonglabs/agent-prompttrain-all-in:${TAG}${NC}"
fi

if [ "$BUILD_ACTION" = "push" ]; then
    echo -e "\n${GREEN}Images pushed to registry!${NC}"
    echo -e "Verify multi-platform manifests with:"
    echo -e "  ${BLUE}docker buildx imagetools inspect moonsonglabs/agent-prompttrain-proxy:latest${NC}"
    echo -e "  ${BLUE}docker buildx imagetools inspect moonsonglabs/agent-prompttrain-dashboard:latest${NC}"
    echo -e "  ${BLUE}docker buildx imagetools inspect moonsonglabs/agent-prompttrain-all-in:latest${NC}"
else
    echo -e "\nTo run the services:"
    echo -e "${YELLOW}Using Docker Compose (recommended):${NC}"
    echo -e "  ${BLUE}# Copy environment file (in project root)${NC}"
    echo -e "  ${BLUE}cp .env.example .env${NC}"
    echo -e "  ${BLUE}# Edit .env with your API keys${NC}"
    echo -e "  ${BLUE}nano .env${NC}"
    echo -e "  ${BLUE}# Run both services${NC}"
    echo -e "  ${BLUE}./docker-up.sh up -d${NC}     # From project root"
    echo -e "  ${BLUE}# Or: cd docker && docker-compose --env-file ../.env up -d${NC}"

    if [ "$TAG" != "latest" ]; then
        echo -e "\n  ${YELLOW}Note: docker-compose.yml uses the 'latest' tag by default${NC}"
        echo -e "  ${YELLOW}To use version ${TAG}, either:${NC}"
        echo -e "  ${BLUE}1. Edit docker/docker-compose.yml to use :${TAG} instead of :latest${NC}"
        echo -e "  ${BLUE}2. Or use docker-compose.override.yml in the docker folder${NC}"
    fi

    echo -e "\n${YELLOW}Using Docker Run:${NC}"
    echo -e "  ${BLUE}# All-in-One (recommended for demos)${NC}"
    echo -e "  ${BLUE}docker run -d -p 3000:3000 -p 3001:3001 moonsonglabs/agent-prompttrain-all-in:${TAG}${NC}"
    echo -e "  ${BLUE}# Or run services separately:${NC}"
    echo -e "  ${BLUE}# Proxy service${NC}"
    echo -e "  ${BLUE}docker run -d -p 3000:3000 moonsonglabs/agent-prompttrain-proxy:${TAG}${NC}"
    echo -e "  ${BLUE}# Dashboard service${NC}"
    echo -e "  ${BLUE}docker run -d -p 3001:3001 -e DASHBOARD_API_KEY=your-key moonsonglabs/agent-prompttrain-dashboard:${TAG}${NC}"

    # Add push instructions
    echo -e "\n${YELLOW}To push to Docker Hub:${NC}"
    echo -e "  ${BLUE}# Use the push script:${NC}"
    echo -e "  ${BLUE}./docker/push-images.sh ${TAG}${NC}"
    echo -e "  ${BLUE}# Or build and push directly:${NC}"
    echo -e "  ${BLUE}BUILD_ACTION=push ./docker/build-images.sh ${TAG}${NC}"
fi

echo -e "\n${YELLOW}Services will be available at:${NC}"
echo -e "  Proxy API: ${GREEN}http://localhost:3000${NC}"
echo -e "  Dashboard: ${GREEN}http://localhost:3001${NC}"