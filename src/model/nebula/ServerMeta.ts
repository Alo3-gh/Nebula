import { Server } from 'helios-distribution-types'
import { MinecraftVersion } from '../../util/MinecraftVersion.js'

export interface UntrackedFilesOption {
    /**
     * The subdirectory these patterns will be applied to. Ex.
     * [ "files", "forgegemods" ]
     */
    appliesTo: string[]
    /**
     * Glob patterns to match against the file.
     */
    patterns: string[]
}

export interface ServerMetaOptions {
    version?: string
    forgeVersion?: string
    fabricVersion?: string
    neoforgeVersion?: string
}

function inferJavaOptions(version: string): NonNullable<Server['javaOptions']> {
    const mcVersion = new MinecraftVersion(version)
    let major: number

    // Forward-compat path for new Minecraft major streams used by this workspace.
    if (mcVersion.getMajor() >= 26) {
        major = 25
    } else if (mcVersion.isGreaterThanOrEqualTo(new MinecraftVersion('1.20.5'))) {
        major = 21
    } else if (mcVersion.isGreaterThanOrEqualTo(new MinecraftVersion('1.18'))) {
        major = 17
    } else {
        major = 8
    }

    return {
        supported: `>=${major} <${major + 1}`,
        suggestedMajor: major
    }
}

export function getDefaultServerMeta(id: string, version: string, options?: ServerMetaOptions): ServerMeta {

    const servMeta: ServerMeta = {
        meta: {
            version: options?.version ?? '1.0.0',
            name: `${id} (Minecraft ${version})`,
            description: `${id} Running Minecraft ${version}`,
            icon: 'How to set the server icon: https://github.com/dscalzi/Nebula#setting-the-server-icon',
            address: 'localhost:25565',
            discord: {
                shortId: '<FILL IN OR REMOVE DISCORD OBJECT>',
                largeImageText: '<FILL IN OR REMOVE DISCORD OBJECT>',
                largeImageKey: '<FILL IN OR REMOVE DISCORD OBJECT>'
            },
            mainServer: false,
            autoconnect: false,
            javaOptions: inferJavaOptions(version)
        }
    }

    if(options?.forgeVersion) {
        servMeta.meta.description = `${servMeta.meta.description} (Forge v${options.forgeVersion})`
        servMeta.forge = {
            version: options.forgeVersion
        }
    }

    if(options?.fabricVersion) {
        servMeta.meta.description = `${servMeta.meta.description} (Fabric v${options.fabricVersion})`
        servMeta.fabric = {
            version: options.fabricVersion
        }
    }

    if(options?.neoforgeVersion) {
        servMeta.meta.description = `${servMeta.meta.description} (NeoForge v${options.neoforgeVersion})`
        servMeta.neoforge = {
            version: options.neoforgeVersion
        }
    }

    // Add empty untracked files.
    servMeta.untrackedFiles = []

    return servMeta
}

export interface ServerMeta {

    /**
     * Server metadata to be forwarded to the distribution file.
     */
    meta: {
        version: Server['version']
        name: Server['name']
        description: Server['description']
        icon?: Server['icon']
        address: Server['address']
        discord?: Server['discord']
        mainServer: Server['mainServer']
        autoconnect: Server['autoconnect']
        javaOptions?: Server['javaOptions']
    }

    /**
     * Properties related to Forge.
     */
    forge?: {
        /**
         * The forge version. This does NOT include the minecraft version.
         * Ex. 14.23.5.2854
         */
        version: string
    }

    /**
     * Properties related to Fabric.
     */
    fabric?: {
        /**
         * The fabric loader version. This does NOT include the minecraft version.
         * Ex. 0.14.18
         */
        version: string
    }

    /**
     * Properties related to NeoForge.
     */
    neoforge?: {
        /**
         * The neoforge version. This does NOT include the minecraft version.
         * Ex. 20.2.86
         */
        version: string
    }

    /**
     * A list of option objects defining patterns for untracked files.
     */
    untrackedFiles?: UntrackedFilesOption[]

}
