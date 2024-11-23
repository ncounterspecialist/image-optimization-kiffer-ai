import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

/**
 * Downloads an image from S3.
 * @param {string} imagePath - The S3 key of the image.
 * @param {object} s3Client - An instance of AWS S3 client.
 * @param {string} S3_BUCKET - The S3 bucket name.
 * @returns {Promise<{ contentType: string, imageBody: Buffer }>}
 */
async function downloadFromS3(imagePath, s3Client, S3_BUCKET) {
    try {

        const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: imagePath });
        console.log("GetObjectCommand", command)
        const output = await s3Client.send(command);

        console.log(`Successfully downloaded image from S3: ${imagePath}`);
        const imageBody = await output.Body.transformToByteArray();
        const contentType = output.ContentType;

        return { contentType, imageBody };
    } catch (error) {
        console.error(`Error downloading image from S3: ${imagePath}`, error);
        throw new Error('Error downloading image from S3');
    }
}

/**
 * Downloads an image from a URL.
 * @param {string} imageUrl - The URL of the image.
 * @returns {Promise<{ contentType: string, imageBody: Buffer }>}
 */
async function downloadFromUrl(base64Url) {
    try {
        // Decode the Base64-encoded URL
        const imageUrl = decodeURIComponent(Buffer.from(base64Url, 'base64').toString('utf-8'));

        // const imageUrl = Buffer.from(base64Url, 'base64').toString('utf-8');

        console.log(`Decoded URL: ${imageUrl}`);
        if(imageUrl.includes("static-assets.kifferai.com")) {
            console.log("cdnurl contains cdn image url. However it only supports 3rd party urls.")
            throw new Error("cdnurl contains cdn image url. However it only supports 3rd party urls.")
        }
        const response = await fetch(imageUrl);

        if (!response.ok) {
            throw new Error(`Failed to fetch the image from URL. Status: ${response.status}`);
        }

        console.log(`Successfully downloaded image from URL: ${imageUrl}`);
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            throw new Error(`Invalid content type: ${contentType}`);
        }

        const imageBody = await response.arrayBuffer();
        return { contentType, imageBody };
    } catch (error) {
        console.error(`Error downloading image from URL: ${base64Url}`, error);
        throw new Error('Error downloading image from URL');
    }
}

/**
 * Processes an image based on operationPrefix.
 * @param {string} operationsPrefix - Indicates whether to use S3 or URL (contains "url" if URL is to be used).
 * @param {string} imagePathOrUrl - S3 key (if S3) or image URL (if URL).
 * @param {object} s3Client - An instance of AWS S3 client.
 * @param {string} S3_BUCKET - S3 bucket name.
 * @returns {Promise<{ contentType: string, originalImageBody: Buffer, sharpObject: sharp }>}
 */
async function processImage(operationsPrefix, originalImagePath, s3Client, S3_BUCKET) {
    let contentType, imageBody;

    if (operationsPrefix.includes('cdnurl')) {
        const imagePathOrUrl = operationsPrefix
            .split(',')
            .map(operation => operation.split('='))
            .filter(x => x[0] === 'cdnurl')[0]?.[1]; // Use optional chaining to avoid errors

        ({ contentType, imageBody } = await downloadFromUrl(imagePathOrUrl));
    } else {
        ({ contentType, imageBody } = await downloadFromS3(originalImagePath, s3Client, S3_BUCKET));
    }

    return {
        contentType,
        originalImageBody: imageBody
    };
}

// Promisify ffmpeg conversion
function convertGifToWebm(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-c:v libvpx-vp9',  // VP9 codec
                '-b:v 0',           // Variable bitrate
                '-crf 41',          // Constant Rate Factor
                '-deadline good',   // Encoding speed preset
                '-cpu-used 5'       // CPU usage preset
            ])
            .toFormat('webm')
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err))
            .save(outputPath);
    });
}

export const handler = async (event) => {
    try {
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);
    // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
    var imagePathArray = event.requestContext.http.path.split('/');
    console.log("imagePathArray: ", imagePathArray)
    // get the requested image operations
    var operationsPrefix = imagePathArray.pop();
    // get the original image path images/rio/1.jpg
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');
    console.log(originalImagePath)

    var startTime = performance.now();
    // Downloading original image
        // const getOriginalImageCommand = new GetObjectCommand({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath });
        // const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);
        // console.log(`Got response from S3 for ${originalImagePath}`);

        // originalImageBody = await getOriginalImageCommandOutput.Body.transformToByteArray();
        // contentType = getOriginalImageCommandOutput.ContentType;
    const {contentType, originalImageBody} = await processImage(operationsPrefix, originalImagePath, s3Client, S3_ORIGINAL_IMAGE_BUCKET)

    // Check if the file is a GIF and conversion to WebM is requested
    const isGif = contentType === 'image/gif';
    const requestedFormat = operationsPrefix.includes('format=webm');

    // Variable to hold the final transformed image
    let transformedImage;
    let finalContentType = contentType;

    try {
        if (isGif && requestedFormat) {
            // GIF to WebM conversion path
            console.log('Converting GIF to WebM');

            // Write input file to /tmp
            const inputPath = `/tmp/input-${Date.now()}.gif`;
            const outputPath = `/tmp/output-${Date.now()}.webm`;

            await fs.writeFile(inputPath, Buffer.from(originalImageBody));

            // Convert to WebM
            await convertGifToWebm(inputPath, outputPath);

            // Read the converted file
            transformedImage = await fs.readFile(outputPath);
            finalContentType = 'video/webm';

            // Clean up temporary files
            await Promise.all([
                fs.unlink(inputPath).catch(() => {}),
                fs.unlink(outputPath).catch(() => {})
            ]);
        } else {
            // Existing image transformation logic using Sharp
            let transformedImageSharp = Sharp(Buffer.from(originalImageBody), { failOn: 'none', animated: true });

            // Get image orientation to rotate if needed
            const imageMetadata = await transformedImageSharp.metadata();

            // Execute the requested operations
            const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));

            // variable holding the server timing header value
            var timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
            startTime = performance.now();

            // Resize if requested
            var resizingOptions = {};
            if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
            if (operationsJSON['height']) resizingOptions.height = parseInt(operationsJSON['height']);
            if (resizingOptions) transformedImageSharp = transformedImageSharp.resize(resizingOptions);

            // Rotate if needed
            if (imageMetadata.orientation) transformedImageSharp = transformedImageSharp.rotate();

            // Format conversion
            if (operationsJSON['format']) {
                var isLossy = false;
                switch (operationsJSON['format']) {
                    case 'jpeg': finalContentType = 'image/jpeg'; isLossy = true; break;
                    case 'gif': finalContentType = 'image/gif'; break;
                    case 'webp': finalContentType = 'image/webp'; isLossy = true; break;
                    case 'png': finalContentType = 'image/png'; break;
                    case 'avif': finalContentType = 'image/avif'; isLossy = true; break;
                    default: finalContentType = 'image/jpeg'; isLossy = true;
                }
            
                if (operationsJSON['quality'] && isLossy) {
                    transformedImageSharp = transformedImageSharp.toFormat(operationsJSON['format'], {
                        quality: parseInt(operationsJSON['quality']),
                    });
                } else {
                    transformedImageSharp = transformedImageSharp.toFormat(operationsJSON['format']);
                }
            } else {
                // SVG handling
                if (contentType === 'image/svg+xml') finalContentType = 'image/png';
            }

            transformedImage = await transformedImageSharp.toBuffer();
        }
    } catch (error) {
        return sendError(500, 'Error transforming image', error);
    }

    timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);

    // Handle gracefully generated images bigger than a specified limit
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    let transformedKey;
    if (isGif && requestedFormat) {
        // For GIF to WebM conversion, replace the file extension
        transformedKey = originalImagePath.replace(/\.gif$/i, '.webm');
    } else {
        // Keep existing logic for other transformations
        transformedKey = originalImagePath + '/' + operationsPrefix;
    }

    // Upload transformed image back to S3 if required
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        try {
            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: transformedImage,
                ContentType: finalContentType,
                CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
            });
            await s3Client.send(putImageCommand);

            timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);

            // If the generated image file is too big, send a redirection
            if (imageTooBig) {
                return {
                    statusCode: 302,
                    headers: {
                        'Location': '/' + originalImagePath + '?' + operationsPrefix.replace(/,/g, "&"),
                        'Cache-Control': 'private,no-store',
                        'Server-Timing': timingLog
                    }
                };
            }
        } catch (error) {
            logError('Could not upload transformed image to S3', error);
        }
    }

    // Return error if the image is too big, else return transformed image
    if (imageTooBig) {
        return sendError(403, 'Requested transformed image is too big', '');
    } else {
        return {
            statusCode: 200,
            body: transformedImage.toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': finalContentType,
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL
            }
        };
    }
    } catch(error) {
        return sendError(500, error.message, error.message);    
    }
};

function sendError(statusCode, body, error) {
    logError(body, error);
    return { statusCode, body };
}

function logError(body, error) {
    console.log('APPLICATION ERROR', body);
    console.log(error);
}