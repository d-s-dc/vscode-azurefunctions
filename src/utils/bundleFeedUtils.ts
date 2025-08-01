/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type IActionContext } from '@microsoft/vscode-azext-utils';
import * as semver from 'semver';
import { ext, TemplateSource } from '../extensionVariables';
import { type IBundleMetadata, type IHostJsonV2 } from '../funcConfig/host';
import { localize } from '../localize';
import { type IBindingTemplate } from '../templates/IBindingTemplate';
import { type FunctionTemplateBase, type IFunctionTemplate } from '../templates/IFunctionTemplate';
import { feedUtils } from './feedUtils';
import { nugetUtils } from './nugetUtils';

export namespace bundleFeedUtils {
    export const defaultBundleId: string = 'Microsoft.Azure.Functions.ExtensionBundle';
    export const defaultVersionRange: string = '[1.*, 2.0.0)';

    interface IBundleFeed {
        defaultVersionRange: string;
        bundleVersions: {
            [bundleVersion: string]: {
                templates: string;
            };
        };
        templates: {
            v1: { // This is the feed's internal schema version, aka _not_ the runtime version
                [templateVersion: string]: ITemplatesReleaseV1;
            };
            v2: { // This is the feed's internal schema version, aka _not_ the runtime version
                [templateVersion: string]: ITemplatesReleaseV2;
            };
        };
    }

    export interface ITemplatesReleaseBase {
        functions: string;
        resources: string;
    }

    export interface ITemplatesReleaseV1 extends ITemplatesReleaseBase {
        bindings: string;
    }

    export interface ITemplatesReleaseV2 extends ITemplatesReleaseBase {
        userPrompts: string;
        // for v3 runtimes, it still uses bindings for user prompts
        bindings?: string;
    }

    export async function getLatestTemplateVersion(context: IActionContext, bundleMetadata: IBundleMetadata | undefined): Promise<string> {
        bundleMetadata = bundleMetadata || {};
        const versionArray: string[] = await feedUtils.getJsonFeed(context, 'https://aka.ms/azFuncBundleVersions');
        const validVersions: string[] = versionArray.filter((v: string) => !!semver.valid(v));
        const bundleVersion: string | undefined = nugetUtils.tryGetMaxInRange(bundleMetadata.version || await getLatestVersionRange(context), validVersions);
        if (!bundleVersion) {
            throw new Error(localize('failedToFindBundleVersion', 'Failed to find bundle version satisfying range "{0}".', bundleMetadata.version));
        } else {
            return bundleVersion;
        }
    }

    export async function getRelease(context: IActionContext, bundleMetadata: IBundleMetadata | undefined, templateVersion: string): Promise<ITemplatesReleaseV1> {
        const feed: IBundleFeed = await getBundleFeed(context, bundleMetadata);
        return feed.templates.v1[templateVersion];
    }

    export async function getReleaseV2(templateVersion: string): Promise<ITemplatesReleaseV2> {
        // build the url ourselves because the index-v2.json file is no longer publishing version updates for v2 templates
        const functionsCdn: string = 'https://cdn.functions.azure.com/public/ExtensionBundles/Microsoft.Azure.Functions.ExtensionBundle/';
        return {
            functions: `${functionsCdn}${templateVersion}/StaticContent/v2/templates/templates.json`,
            bindings: `${functionsCdn}${templateVersion}/StaticContent/v2/bindings/userPrompts.json`,
            userPrompts: `${functionsCdn}${templateVersion}/StaticContent/v2/bindings/userPrompts.json`,
            resources: `${functionsCdn}${templateVersion}/StaticContent/v2/resources/Resources.{locale}.json`,
        }
    }

    export function isBundleTemplate(template: FunctionTemplateBase | IBindingTemplate): boolean {
        const bundleTemplateTypes: string[] = ['durable', 'signalr'];
        return (!template.isHttpTrigger && !template.isTimerTrigger) || bundleTemplateTypes.some(t => isTemplateOfType(template, t));
    }

    export async function getLatestVersionRange(context: IActionContext): Promise<string> {
        const feed: IBundleFeed = await getBundleFeed(context, undefined);
        return feed.defaultVersionRange;
    }

    export async function addDefaultBundle(context: IActionContext, hostJson: IHostJsonV2): Promise<void> {
        let versionRange: string;
        try {
            versionRange = (await getLatestVersionRange(context)) ?? defaultVersionRange;
        } catch {
            versionRange = defaultVersionRange;
        }

        hostJson.extensionBundle = {
            id: defaultBundleId,
            version: versionRange
        };
    }

    function isTemplateOfType(template: Partial<IFunctionTemplate>, templateType: string): boolean {
        return !!template.id?.toLowerCase().includes(templateType.toLowerCase());
    }

    async function getBundleFeed(context: IActionContext, bundleMetadata: IBundleMetadata | undefined): Promise<IBundleFeed> {
        const bundleId: string = bundleMetadata && bundleMetadata.id || defaultBundleId;

        const envVarUri: string | undefined = process.env.FUNCTIONS_EXTENSIONBUNDLE_SOURCE_URI;
        // Only use an aka.ms link for the most common case, otherwise we will dynamically construct the url
        let url: string;
        const templateProvider = ext.templateProvider.get(context);
        if (!envVarUri && bundleId === defaultBundleId && templateProvider.templateSource !== TemplateSource.Staging) {
            url = 'https://aka.ms/bundleFeedUtilsV2';
        } else {
            const suffix: string = templateProvider.templateSource === TemplateSource.Staging ? '-staging' : '';
            const baseUrl: string = envVarUri || `https://cdn${suffix}.functions.azure.com/public`;
            url = `${baseUrl}/ExtensionBundles/${bundleId}/index-v2.json`;
        }

        return feedUtils.getJsonFeed(context, url);
    }

    export function overwriteExtensionBundleVersion(hostJson: IHostJsonV2, expectedRange: string, newRange: string): void {
        if (hostJson.extensionBundle && hostJson.extensionBundle.version === expectedRange) {
            hostJson.extensionBundle.version = newRange;
        }
    }
}
