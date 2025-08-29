#!/bin/bash

# Script to manage agent-prompttrain-proxy Docker containers across all Agent Prompt Train EC2 instances
# Dynamically fetches EC2 instances from AWS

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Function to display usage
usage() {
    echo "Usage: $0 [--env {prod|staging}] {up|down|status|exec} [server-name|command]"
    echo ""
    echo "Commands:"
    echo "  up      - Enable/start the agent-prompttrain-proxy container"
    echo "  down    - Disable/stop the agent-prompttrain-proxy container"
    echo "  status  - Check the status of the agent-prompttrain-proxy container"
    echo "  exec    - Execute a bash command on the server(s)"
    echo ""
    echo "Options:"
    echo "  --env {prod|staging} - Filter servers by environment tag (optional)"
    echo "  server-name          - Optional. If not provided, the command will run on all servers"
    echo ""
    echo "Examples:"
    echo "  $0 status                       # Check status on all servers"
    echo "  $0 --env prod up               # Start proxy on all production servers"
    echo "  $0 --env staging status server1 # Check status on specific staging server"
    echo "  $0 exec \"ls -la\"               # List files on all servers"
    echo "  $0 exec \"docker ps\"            # Show docker containers on all servers"
    echo "  $0 exec server1 \"df -h\"        # Check disk space on specific server"
    echo ""
    echo "The script will dynamically fetch EC2 instances with 'Agent Prompt Train' in their name,"
    echo "filtered by environment tag if specified."
    exit 1
}

# Parse command line arguments
ENV_FILTER=""
COMMAND=""
SERVER_NAME=""
EXEC_COMMAND=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --env)
            if [[ -z "$2" ]] || [[ "$2" == --* ]]; then
                echo -e "${RED}Error: --env requires a value (prod or staging)${NC}"
                usage
            fi
            ENV_FILTER="$2"
            if [[ ! "$ENV_FILTER" =~ ^(prod|staging)$ ]]; then
                echo -e "${RED}Error: Invalid environment '$ENV_FILTER'. Must be 'prod' or 'staging'${NC}"
                usage
            fi
            shift 2
            ;;
        up|down|status)
            if [[ -n "$COMMAND" ]]; then
                echo -e "${RED}Error: Command already specified as '$COMMAND'${NC}"
                usage
            fi
            COMMAND="$1"
            shift
            ;;
        exec)
            if [[ -n "$COMMAND" ]]; then
                echo -e "${RED}Error: Command already specified as '$COMMAND'${NC}"
                usage
            fi
            COMMAND="$1"
            shift
            # Capture all remaining arguments as the command to execute
            EXEC_COMMAND="$*"
            break  # Stop parsing to preserve the command
            ;;
        *)
            if [[ -z "$COMMAND" ]]; then
                echo -e "${RED}Error: Unknown option or command '$1'${NC}"
                usage
            elif [[ -z "$SERVER_NAME" ]]; then
                SERVER_NAME="$1"
                shift
            else
                echo -e "${RED}Error: Too many arguments${NC}"
                usage
            fi
            ;;
    esac
done

# Check if command is provided
if [[ -z "$COMMAND" ]]; then
    echo -e "${RED}Error: No command specified${NC}"
    usage
fi

# Validate command
if [[ ! "$COMMAND" =~ ^(up|down|status|exec)$ ]]; then
    echo -e "${RED}Error: Invalid command '$COMMAND'${NC}"
    usage
fi

# Special validation for exec command
if [[ "$COMMAND" == "exec" ]] && [[ -z "$EXEC_COMMAND" ]]; then
    echo -e "${RED}Error: 'exec' command requires a bash command to execute${NC}"
    echo "Example: $0 exec \"ls -la\""
    exit 1
fi

# Check if AWS CLI is configured
aws sts get-caller-identity &>/dev/null
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: AWS CLI is not configured. Please run 'aws configure' first.${NC}"
    exit 1
fi

# Global variable for instances
declare -g INSTANCES=""

# Function to pull latest code on remote server
pull_latest_code() {
    local ip=$1
    local name=$2
    
    echo -e "${BLUE}Pulling latest code on $name...${NC}"
    
    ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
        "cd ~/agent-prompttrain && git pull origin main" 2>&1
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Code updated successfully${NC}"
        return 0
    else
        echo -e "${YELLOW}⚠ Warning: Could not pull latest code (continuing anyway)${NC}"
        return 1
    fi
}

# Function to fetch EC2 instances
fetch_ec2_instances() {
    local env_display=""
    if [[ -n "$ENV_FILTER" ]]; then
        if [[ "$ENV_FILTER" == "prod" ]]; then
            env_display="${RED}PRODUCTION${NC}"
        else
            env_display="${YELLOW}STAGING${NC}"
        fi
        echo -e "${YELLOW}Fetching ${env_display} EC2 instances from AWS...${NC}"
    else
        echo -e "${YELLOW}Fetching EC2 instances from AWS (all environments)...${NC}"
    fi
    
    # Build jq filter based on whether env filter is specified
    local jq_filter='
        [.Reservations[].Instances[] | 
        select(.Tags[]?.Value | ascii_downcase | contains("agent") and contains("prompttrain")) | 
        select(.State.Name == "running") |
        {
            Name: (.Tags[] | select(.Key=="Name").Value),
            PublicIP: .PublicIpAddress,
            InstanceId: .InstanceId,
            Environment: ((.Tags[] | select(.Key=="env").Value) // "unknown")
        }'
    
    # Add environment filter if specified
    if [[ -n "$ENV_FILTER" ]]; then
        jq_filter+=' | select(.Environment == "'$ENV_FILTER'")'
    fi
    
    jq_filter+=' | select(.PublicIP != null)]'
    
    # Get instances with Nexus Proxy in their name - store as JSON array
    local raw_instances=$(aws ec2 describe-instances --output json | jq -c "$jq_filter")
    
    if [ "$raw_instances" = "[]" ] || [ -z "$raw_instances" ]; then
        if [[ -n "$ENV_FILTER" ]]; then
            echo -e "${RED}No running EC2 instances found with 'Agent Prompt Train' in their name and env='$ENV_FILTER'.${NC}"
        else
            echo -e "${RED}No running EC2 instances found with 'Agent Prompt Train' in their name.${NC}"
        fi
        exit 1
    fi
    
    # Store instances for later use
    INSTANCES="$raw_instances"
    
    echo -e "${GREEN}Found EC2 instances:${NC}"
    echo "$INSTANCES" | jq -r '.[] | 
        if .Environment == "prod" then
            "\(.Name) (\(.PublicIP)) [\u001b[0;31mPROD\u001b[0m]"
        elif .Environment == "staging" then
            "\(.Name) (\(.PublicIP)) [\u001b[1;33mSTAGING\u001b[0m]"
        else
            "\(.Name) (\(.PublicIP)) [unknown]"
        end'
    echo ""
}

# Function to execute command on a single server (background version)
execute_on_server_async() {
    local name=$1
    local ip=$2
    local cmd=$3
    local output_file=$4
    local env=$5
    
    {
        local env_display=""
        if [[ "$env" == "prod" ]]; then
            env_display=" ${RED}[PROD]${NC}"
        elif [[ "$env" == "staging" ]]; then
            env_display=" ${YELLOW}[STAGING]${NC}"
        elif [[ "$env" != "unknown" ]] && [[ -n "$env" ]]; then
            env_display=" [$env]"
        fi
        
        echo -e "${YELLOW}Connecting to $name ($ip)$env_display...${NC}"
        
        case $cmd in
            "up")
                # Pull latest code before updating
                ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
                    "cd ~/agent-prompttrain && git pull origin main" 2>&1
                
                if [ $? -eq 0 ]; then
                    echo -e "${GREEN}✓ Code updated${NC}"
                    
                    # Now run the update script
                    ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
                        "cd ~ && ./agent-prompttrain-proxy/scripts/ops/update-proxy.sh latest proxy" 2>&1
                else
                    echo -e "${RED}✗ Failed to pull latest code. Aborting update for $name.${NC}"
                    echo -e "${RED}Please resolve git issues on the server before retrying.${NC}"
                    exit 1
                fi
                ;;
            "down")
                ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
                    "docker stop agent-prompttrain-proxy 2>/dev/null || true" 2>&1
                ;;
            "status")
                ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
                    "docker ps -a --filter name=agent-prompttrain-proxy --format 'table {{.Names}}\t{{.Status}}'" 2>&1
                ;;
            "exec")
                # Execute the custom command - SSH handles escaping properly
                ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip "$EXEC_COMMAND" 2>&1
                ;;
        esac
        
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓ $name: Command executed successfully${NC}"
        else
            echo -e "${RED}✗ $name: Command failed or connection timeout${NC}"
        fi
        echo ""
    } > "$output_file" 2>&1
}

# Function to execute command on a single server (synchronous)
execute_on_server() {
    local name=$1
    local ip=$2
    local cmd=$3
    local env=$4
    
    local env_display=""
    if [[ "$env" == "prod" ]]; then
        env_display=" ${RED}[PROD]${NC}"
    elif [[ "$env" == "staging" ]]; then
        env_display=" ${YELLOW}[STAGING]${NC}"
    elif [[ "$env" != "unknown" ]] && [[ -n "$env" ]]; then
        env_display=" [$env]"
    fi
    
    echo -e "${YELLOW}Connecting to $name ($ip)$env_display...${NC}"
    
    case $cmd in
        "up")
            # Pull latest code before updating
            ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
                "cd ~/agent-prompttrain && git pull origin main" 2>&1
            
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓ Code updated${NC}"
                
                # Now run the update script
                ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
                    "cd ~ && ./agent-prompttrain-proxy/scripts/ops/update-proxy.sh latest proxy" 2>&1
            else
                echo -e "${RED}✗ Failed to pull latest code. Aborting update for $name.${NC}"
                echo -e "${RED}Please resolve git issues on the server before retrying.${NC}"
                return 1
            fi
            ;;
        "down")
            ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
                "docker stop agent-prompttrain-proxy 2>/dev/null || true" 2>&1
            ;;
        "status")
            ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip \
                "docker ps -a --filter name=agent-prompttrain-proxy --format 'table {{.Names}}\t{{.Status}}'" 2>&1
            ;;
        "exec")
            # Execute the custom command - SSH handles escaping properly
            ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$ip "$EXEC_COMMAND" 2>&1
            ;;
    esac
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ $name: Command executed successfully${NC}"
    else
        echo -e "${RED}✗ $name: Command failed or connection timeout${NC}"
    fi
    echo ""
}

# Main execution
echo -e "${GREEN}=== Agent Prompt Train Manager ===${NC}"
if [[ -n "$ENV_FILTER" ]]; then
    if [[ "$ENV_FILTER" == "prod" ]]; then
        echo -e "Environment: ${RED}PRODUCTION${NC}"
    else
        echo -e "Environment: ${YELLOW}STAGING${NC}"
    fi
else
    echo -e "Environment: ${BLUE}ALL${NC}"
fi
echo ""

# Fetch EC2 instances
fetch_ec2_instances

# If server name is provided, execute on that server only
if [ -n "$SERVER_NAME" ]; then
    # Check if server exists
    SERVER_INFO=$(echo "$INSTANCES" | jq -r --arg name "$SERVER_NAME" '.[] | select(.Name == $name)')
    
    if [ -z "$SERVER_INFO" ]; then
        echo -e "${RED}Error: Server '$SERVER_NAME' not found${NC}"
        echo ""
        echo "Available servers:"
        echo "$INSTANCES" | jq -r '.[] | 
            "\(.Name) [" + .Environment + "]"'
        exit 1
    fi
    
    IP=$(echo "$SERVER_INFO" | jq -r '.PublicIP')
    ENV=$(echo "$SERVER_INFO" | jq -r '.Environment')
    execute_on_server "$SERVER_NAME" "$IP" "$COMMAND" "$ENV"
else
    # Execute on all servers
    echo -e "${YELLOW}Executing '$COMMAND' on all servers concurrently...${NC}"
    echo ""
    
    # Create temp directory for output files
    TEMP_DIR=$(mktemp -d)
    trap "rm -rf $TEMP_DIR" EXIT
    
    # Process each instance in the JSON array
    # Get the number of instances
    NUM_INSTANCES=$(echo "$INSTANCES" | jq 'length')
    
    # Arrays to store PIDs and server info
    declare -a PIDS=()
    declare -a NAMES=()
    declare -a OUTPUT_FILES=()
    
    # Launch all SSH connections in parallel
    for ((i=0; i<$NUM_INSTANCES; i++)); do
        INSTANCE=$(echo "$INSTANCES" | jq -c ".[$i]")
        NAME=$(echo "$INSTANCE" | jq -r '.Name')
        IP=$(echo "$INSTANCE" | jq -r '.PublicIP')
        ENV=$(echo "$INSTANCE" | jq -r '.Environment')
        OUTPUT_FILE="$TEMP_DIR/output_$i.txt"
        
        # Execute in background
        execute_on_server_async "$NAME" "$IP" "$COMMAND" "$OUTPUT_FILE" "$ENV" &
        PIDS+=($!)
        NAMES+=("$NAME")
        OUTPUT_FILES+=("$OUTPUT_FILE")
    done
    
    # Wait for all background jobs to complete
    echo -e "${YELLOW}Waiting for all servers to respond...${NC}"
    echo ""
    
    # Wait for all PIDs
    for pid in "${PIDS[@]}"; do
        wait $pid
    done
    
    # Display results in order
    for ((i=0; i<${#OUTPUT_FILES[@]}; i++)); do
        if [ -f "${OUTPUT_FILES[$i]}" ]; then
            cat "${OUTPUT_FILES[$i]}"
        fi
    done
fi

echo -e "${GREEN}=== Operation completed ===${NC}"