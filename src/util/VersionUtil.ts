import got from 'got'
import { PromotionsSlim } from '../model/forge/PromotionsSlim.js'
import { MinecraftVersion } from './MinecraftVersion.js'
import { LoggerUtil } from './LoggerUtil.js'
import { FabricInstallerMeta, FabricLoaderMeta, FabricProfileJson, FabricVersionMeta } from '../model/fabric/FabricMeta.js'

export class VersionUtil {

    private static readonly logger = LoggerUtil.getLogger('VersionUtil')

    public static readonly PROMOTION_TYPE = [
        'recommended',
        'latest'
    ]

    public static isVersionAcceptable(version: MinecraftVersion, acceptable: number[]): boolean {
        if (version.getMajor() === 1) {
            return acceptable.find((element) => version.getMinor() === element) != null
        }
        return false
    }

    public static versionGte(version: string, min: string): boolean {

        if(version === min) {
            return true
        }

        const left = version.split('.').map(x => Number(x))
        const right = min.split('.').map(x => Number(x))

        if(left.length != right.length) {
            throw new Error('Cannot compare mismatched versions.')
        }

        for(let i=0; i<left.length; i++) {
            if(left[i] > right[i]) {
                return true
            }
        }

        return false
    }

    public static isPromotionVersion(version: string): boolean {
        return VersionUtil.PROMOTION_TYPE.includes(version.toLowerCase())
    }

    // -------------------------------
    // Forge

    public static isOneDotTwelveFG2(libraryVersion: string): boolean {
        const maxFG2 = [14, 23, 5, 2847]
        const verSplit = libraryVersion.split('.').map(v => Number(v))

        for(let i=0; i<maxFG2.length; i++) {
            if(verSplit[i] > maxFG2[i]) {
                return false
            }
        }
        
        return true
    }

    public static async getPromotionIndex(): Promise<PromotionsSlim> {
        const response = await got.get<PromotionsSlim>({
            method: 'get',
            url: 'https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json',
            responseType: 'json'
        })
        return response.body
    }

    public static getPromotedVersionStrict(index: PromotionsSlim, minecraftVersion: MinecraftVersion, promotion: string): string {
        const workingPromotion = promotion.toLowerCase()
        return index.promos[`${minecraftVersion}-${workingPromotion}`]
    }

    public static async getPromotedForgeVersion(minecraftVersion: MinecraftVersion, promotion: string): Promise<string> {
        const workingPromotion = promotion.toLowerCase()
        const res = await VersionUtil.getPromotionIndex()
        let version = res.promos[`${minecraftVersion}-${workingPromotion}`]
        if (version == null) {
            VersionUtil.logger.warn(`No ${workingPromotion} version found for Forge ${minecraftVersion}.`)
            VersionUtil.logger.warn('Attempting to pull latest version instead.')
            version = res.promos[`${minecraftVersion}-latest`]
            if (version == null) {
                throw new Error(`No latest version found for Forge ${minecraftVersion}.`)
            }
        }
        return version
    }

    // -------------------------------
    // Fabric

    public static async getFabricInstallerMeta(): Promise<FabricInstallerMeta[]> {
        const response = await got.get<FabricInstallerMeta[]>({
            method: 'get',
            url: 'https://meta.fabricmc.net/v2/versions/installer',
            responseType: 'json'
        })
        return response.body
    }

    public static async getFabricLoaderMeta(): Promise<FabricLoaderMeta[]> {
        const response = await got.get<FabricLoaderMeta[]>({
            method: 'get',
            url: 'https://meta.fabricmc.net/v2/versions/loader',
            responseType: 'json'
        })
        return response.body
    }

    public static async getFabricGameMeta(): Promise<FabricVersionMeta[]> {
        const response = await got.get<FabricVersionMeta[]>({
            method: 'get',
            url: 'https://meta.fabricmc.net/v2/versions/game',
            responseType: 'json'
        })
        return response.body
    }

    public static async getFabricProfileJson(gameVersion: string, loaderVersion: string): Promise<FabricProfileJson> {
        const response = await got.get<FabricProfileJson>({
            method: 'get',
            url: `https://meta.fabricmc.net/v2/versions/loader/${gameVersion}/${loaderVersion}/profile/json`,
            responseType: 'json'
        })
        return response.body
    }

    public static async getPromotedFabricVersion(promotion: string): Promise<string> {
        const stable = promotion.toLowerCase() === 'recommended'
        const fabricLoaderMeta = await this.getFabricLoaderMeta()
        return !stable ? fabricLoaderMeta[0].version : fabricLoaderMeta.find(({ stable }) => stable)!.version
    }

    // -------------------------------
    // NeoForge

    public static async getNeoForgeVersions(): Promise<string[]> {
        const response = await got.get('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml').text()

        const matches = response.match(/<version>([^<]+)<\/version>/g) ?? []
        return matches
            .map(val => val.replace('<version>', '').replace('</version>', ''))
            .filter(val => /^\d+\.\d+\.\d+/.test(val))
    }

    public static async getPromotedNeoForgeVersion(minecraftVersion: MinecraftVersion, promotion: string): Promise<string> {
        const versions = await this.getNeoForgeVersions()
        const revision = minecraftVersion.getRevision()
        const fullPrefix = revision != null ? `${minecraftVersion.getMinor()}.${revision}.` : `${minecraftVersion.getMinor()}.`
        let candidates = versions.filter(v => v.startsWith(fullPrefix))
        if (candidates.length === 0) {
            candidates = versions.filter(v => v.startsWith(`${minecraftVersion.getMinor()}.`))
        }
        if(candidates.length === 0) {
            throw new Error(`No NeoForge versions found for Minecraft ${minecraftVersion}.`)
        }

        // NeoForge doesn't expose "recommended" like forge promotions.
        // For now, map both recommended/latest to newest available patch in the MC line.
        const requested = promotion.toLowerCase()
        if (!['latest', 'recommended'].includes(requested)) {
            return promotion
        }
        return candidates[candidates.length - 1]
    }

}
