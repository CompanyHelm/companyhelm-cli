import { z } from "zod";

const DEFAULT_RUNTIME_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"] as const;

function parseRuntimeDnsServers(value: unknown): unknown {
    if (typeof value !== "string") {
        return value;
    }

    return value
        .split(",")
        .map((server) => server.trim())
        .filter((server) => server.length > 0);
}

export const codexConfig = z.object({
    codex_auth_file_path: z.string()
        .describe("The path to the Codex authentication file on the host, relative to config_directory.")
        .default("codex-auth.json"),
    codex_auth_path: z.string()
        .describe("The path to the Codex auth file. Used on both host and inside the container.")
        .default("~/.codex/auth.json"),
    codex_auth_port: z.number()
        .describe("The port used by Codex OAuth callback during dedicated auth.")
        .default(1455),
    app_server_client_name: z.string()
        .describe("Client name reported to Codex app-server during initialize.")
        .default("cli"),
});

export const config = z.object({
    config_directory: z.string()
        .describe("The directory where the config files are stored.")
        .default("~/.config/companyhelm"),
    workspaces_directory: z.string()
        .describe("The directory where thread workspaces are stored, relative to config_directory when not absolute.")
        .default("workspaces"),
    state_db_path: z.string()
        .describe("The path to the state database.")
        .default("~/.local/share/companyhelm/state.db"),
    companyhelm_api_url: z.string()
        .describe("CompanyHelm control plane gRPC endpoint URL.")
        .default("api.companyhelm.com/grpc"),
    // Max outbound gRPC client messages to hold while the command channel is disconnected.
    client_message_buffer_limit: z.number()
        .int()
        .positive()
        .describe("Maximum number of outbound client messages buffered during command channel disconnects.")
        .default(10_000),
    runtime_image: z.string()
        .describe("The name of the runtime image.")
        .default("companyhelm/runner:latest"),
    dind_image: z.string()
        .describe("The name of the DIND image.")
        .default("docker:29-dind-rootless"),
    use_host_docker_runtime: z.boolean()
        .describe("When true, mount host Docker socket into runtime containers instead of creating DinD sidecars.")
        .default(false),
    host_docker_path: z.string()
        .describe(
            "Host Docker endpoint when use_host_docker_runtime is enabled. Supported: unix:///<socket-path> or tcp://localhost:<port>.",
        )
        .default("unix:///var/run/docker.sock"),
    runtime_dns_servers: z.preprocess(
        parseRuntimeDnsServers,
        z.array(z.string().min(1)),
    )
        .describe("DNS servers applied to runtime-related Docker containers.")
        .default(() => [...DEFAULT_RUNTIME_DNS_SERVERS]),
    agent_user: z.string()
        .describe("The user for the agent.")
        .default("agent"),
    agent_home_directory: z.string()
        .describe("The home directory for the agent.")
        .default("/home/agent"),
    git_user_name: z.string()
        .describe("Default git author name used when runtime repositories are missing user.name.")
        .default("agent"),
    git_user_email: z.string()
        .describe("Default git author email used when runtime repositories are missing user.email.")
        .default("agent@companyhelm.com"),
    codex: codexConfig.default(() => codexConfig.parse({})),
});

export type Config = z.infer<typeof config>;
export type CodexConfig = z.infer<typeof codexConfig>;
