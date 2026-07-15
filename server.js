const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { google } = require("googleapis");
const path = require("path");
const sharp = require("sharp");
const JSZip = require("jszip");
const { Readable } = require("stream");
const app = express();
const axios = require("axios");
const FormData = require("form-data");
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

require("dotenv").config();
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
    credential: cert(serviceAccount)
});
const db = getFirestore();
const auth = getAuth();

app.use(cors({
    origin: [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://immortal-library.web.app",
        "https://immortal-library.firebaseapp.com",
        "https://library.btgw.in"
    ]
}));
app.use(express.json({ limit: "50mb" }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024
    }
});

const DRIVE_SCOPES = [
    "https://www.googleapis.com/auth/drive"
];

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REFRESH_TOKEN = (process.env.GOOGLE_REFRESH_TOKEN || "").trim();

const hasOAuthDriveCreds = Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET &&
    GOOGLE_REFRESH_TOKEN
);

function createDriveAuthClient(){
    if(hasOAuthDriveCreds){
        const oauth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET
        );

        oauth2Client.setCredentials({
            refresh_token: GOOGLE_REFRESH_TOKEN
        });

        return oauth2Client;
    }

    throw new Error("Google Drive credentials are not configured.");
}

const driveAuthClient = createDriveAuthClient();
const drive = google.drive({version:"v3", auth:driveAuthClient});

/*
Immortal Library
└── Books
*/

const BOOKS_FOLDER_ID = "1ZBFaiY2pORDGrf8UB4DsgjnkoBCedFPS";
const ALLOWED_AVATAR_HOSTS = new Set([
    "lh3.googleusercontent.com",
    "lh4.googleusercontent.com",
    "lh5.googleusercontent.com",
    "lh6.googleusercontent.com"
]);

app.get("/", (req, res) => {
    res.send("Immortal Library Backend Running");
});

async function uploadToDrive(file, folderId){
    if(!file?.buffer){
        throw new Error("Missing EPUB file.");
    }
    if(!hasOAuthDriveCreds){
        throw new Error("Google Drive credentials are not configured.");
    }
    if(!folderId){
        throw new Error("Google Drive folder is not configured.");
    }
    const response = await drive.files.create({
        supportsAllDrives:true,
        requestBody:{
            name:file.originalname || "book.epub",
            parents:[folderId]
        },
        media:{
            mimeType:file.mimetype || "application/epub+zip",
            body:Readable.from(file.buffer)
        },
        fields:"id,name"
    });
    await drive.permissions.create({
        supportsAllDrives:true,
        fileId:response.data.id,
        requestBody:{
            role:"reader",
            type:"anyone"
        }
    });
    const fileId=response.data.id;
    return{
        fileId,
        downloadUrl:
            `https://drive.google.com/uc?export=download&id=${fileId}`,
        viewUrl:
            `https://drive.google.com/file/d/${fileId}/view`
    };
}

async function uploadToImgBB(file) {
    if(!file?.buffer){
        throw new Error("Missing cover image.");
    }
    if(!process.env.IMGBB_API_KEY){
        throw new Error("ImgBB API key is not configured.");
    }

    const form = new FormData();

    form.append(
        "image",
        file.buffer.toString("base64")
    );

    form.append(
        "name",
        path.parse(file.originalname).name
    );

    const response = await axios.post(
        `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
        form,
        {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        }
    );

    const imageUrl=response.data?.data?.url;
    if(!imageUrl){
        throw new Error("ImgBB upload failed.");
    }

    return imageUrl;

}

async function uploadAvatarUrlToImgBB(photoUrl, fileName) {
    if(!process.env.IMGBB_API_KEY){
        throw new Error("ImgBB API key is not configured.");
    }
    const url = new URL(photoUrl);
    if (
        url.protocol !== "https:" ||
        !ALLOWED_AVATAR_HOSTS.has(url.hostname)
    ) {
        throw new Error("Invalid avatar URL.");
    }
    const imageResponse = await axios.get(photoUrl, {
        responseType: "arraybuffer",
        timeout: 10000,
        maxRedirects: 2
    });
    const form = new FormData();
    form.append(
        "image",
        Buffer.from(imageResponse.data).toString("base64")
    );
    form.append(
        "name",
        fileName
    );
    const response = await axios.post(
        `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
        form,
        {
            headers: form.getHeaders(),
            maxBodyLength: Infinity
        }
    );
    return {
        avatar: response.data.data.url,
        deleteUrl: response.data.data.delete_url || null
    };
}

async function uploadValidatedImageToImgBB(buffer, fileName){
    if(!process.env.IMGBB_API_KEY){
        throw new Error("ImgBB API key is not configured.");
    }

    const form = new FormData();
    form.append(
        "image",
        buffer.toString("base64")
    );
    form.append(
        "name",
        fileName
    );

    const response = await axios.post(
        `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
        form,
        {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        }
    );

    const data = response.data?.data || {};
    const imageUrl = data.url;
    if(!imageUrl){
        throw new Error("ImgBB upload failed.");
    }

    return {
        imageUrl,
        deleteUrl: data.delete_url || null
    };
}

async function deleteImgBBImage(deleteUrl){
    if(!deleteUrl){
        return false;
    }

    const response = await axios.get(deleteUrl, {
        timeout: 10000,
        maxRedirects: 2
    });

    return response.status >= 200 && response.status < 400;
}

function generateAdminUsername(displayName){
    const username = String(displayName || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

    if(username){
        return username;
    }

    return `user${Math.floor(10000000 + Math.random() * 90000000)}`;
}

function parseDataUrlImagePayload(value, fieldName){
    if(value === undefined || value === null || value === ""){
        return null;
    }

    if(typeof value !== "string"){
        throw new Error(`Invalid ${fieldName}.`);
    }

    const match = value.match(/^data:([^;,]+);base64,(.+)$/i);
    if(!match){
        throw new Error(`Invalid ${fieldName}.`);
    }

    const mimeType = match[1].toLowerCase();
    if(!mimeType.startsWith("image/")){
        throw new Error(`Invalid ${fieldName}.`);
    }

    const buffer = Buffer.from(match[2], "base64");
    if(!buffer.length){
        throw new Error(`Invalid ${fieldName}.`);
    }

    return {
        buffer,
        mimeType
    };
}

async function validateEditableImage(buffer, fieldName, declaredMimeType = ""){
    const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
    const ALLOWED_FORMATS = new Set([
        "jpeg",
        "jpg",
        "png",
        "webp",
        "gif",
        "avif",
        "tiff",
        "heif",
        "heic"
    ]);

    if(!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES){
        throw new Error(`Invalid ${fieldName}.`);
    }

    if(
        typeof declaredMimeType === "string" &&
        declaredMimeType.toLowerCase() === "image/svg+xml"
    ){
        throw new Error(`Invalid ${fieldName}.`);
    }

    let metadata;
    try{
        metadata = await sharp(buffer, { failOnError: true }).metadata();
    }
    catch{
        throw new Error(`Invalid ${fieldName}.`);
    }

    if(
        !metadata?.format ||
        !ALLOWED_FORMATS.has(metadata.format) ||
        !metadata.width ||
        !metadata.height
    ){
        throw new Error(`Invalid ${fieldName}.`);
    }

    if(metadata.width * metadata.height > 40000000){
        throw new Error(`Invalid ${fieldName}.`);
    }
}

async function validateCover(file){
    if(!file.mimetype.startsWith("image/")){
        throw new Error("Invalid cover image.");
    }
    const meta=await sharp(file.buffer).metadata();
    if(!meta.width || !meta.height){
        throw new Error("Invalid cover image.");
    }
    const ratio=meta.width/meta.height;
    if(Math.abs(ratio-0.75)>0.02){
        throw new Error("Cover must be 3:4.");
    }
}

async function validateEpub(file){
    const allowedMimeTypes=new Set([
        "application/epub+zip",
        "application/octet-stream",
        "application/zip",
        "application/x-zip-compressed"
    ]);
    const fileName=(file.originalname || "").toLowerCase();
    if(
        file.mimetype &&
        !allowedMimeTypes.has(file.mimetype) &&
        !fileName.endsWith(".epub")
    ){
        throw new Error("Invalid EPUB.");
    }
    const zip=await JSZip.loadAsync(file.buffer);
    const mimetypeFile=zip.file("mimetype");
    if(!mimetypeFile){
        throw new Error("Invalid EPUB.");
    }
    const mime=await mimetypeFile.async("text");
    if(mime.trim()!=="application/epub+zip"){
        throw new Error("Invalid EPUB.");
    }
    if(!zip.file("META-INF/container.xml")){
        throw new Error("Corrupted EPUB.");
    }
}

function sendFailure(res, status, message){
    return res.status(status).json({
        success:false,
        message
    });
}

function requireStringField(value, fieldName){
    if(typeof value !== "string" || !value.trim()){
        throw new Error(`Missing ${fieldName}.`);
    }
    return value.trim();
}

function parseIntegerField(value, fieldName, options = {}){
    const { defaultValue, min } = options;

    if(value === undefined || value === null || value === ""){
        if(defaultValue !== undefined){
            return defaultValue;
        }
        throw new Error(`Missing ${fieldName}.`);
    }

    const parsed=Number(value);

    if(!Number.isInteger(parsed)){
        throw new Error(`Invalid ${fieldName}.`);
    }

    if(min !== undefined && parsed < min){
        throw new Error(`Invalid ${fieldName}.`);
    }

    return parsed;
}

function parseJsonArrayField(value, fieldName, options = {}){
    const { lowercase = false } = options;

    if(value === undefined || value === null || value === ""){
        return [];
    }

    let parsed=value;

    if(typeof value === "string"){
        try{
            parsed=JSON.parse(value);
        }
        catch{
            throw new Error(`Invalid ${fieldName}.`);
        }
    }

    if(!Array.isArray(parsed)){
        throw new Error(`Invalid ${fieldName}.`);
    }

    return parsed
        .map(item=>{
            if(typeof item !== "string"){
                throw new Error(`Invalid ${fieldName}.`);
            }

            const normalized=item.trim();
            return lowercase
                ? normalized.toLowerCase()
                : normalized;
        })
        .filter(Boolean);
}

function normalizeBookId(rawBookId, rawBookName){
    const source=
        typeof rawBookId === "string" && rawBookId.trim()
            ? rawBookId
            : rawBookName;

    if(typeof source !== "string"){
        return "";
    }

    return source
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g,"")
        .toLowerCase()
        .replace(/[^a-z0-9]/g,"");
}

async function getUniqueBookId(epubsCollection, baseBookId){
    let candidate=baseBookId;
    let counter=1;

    while(true){
        const doc=await epubsCollection.doc(candidate).get();
        if(!doc.exists){
            return candidate;
        }

        candidate=`${baseBookId}${counter}`;
        counter++;
    }
}

function buildBrowseEntry(finalData){
    return {
        alternateTitles:finalData.alternateTitles,
        authorName:finalData.authorName,
        bookId:finalData.bookId,
        bookName:finalData.bookName,
        category:finalData.category,
        chapterNumber:finalData.chapterNumber,
        coverUrl:finalData.coverUrl,
        createdAt:finalData.createdAt,
        genres:finalData.genres,
        language:finalData.language,
        mainGenre:finalData.mainGenre,
        origin:finalData.origin,
        status:finalData.status,
        tags:finalData.tags,
        updatedAt:finalData.updatedAt,
        uploaderUid:finalData.uploaderUid
    };
}

function getExternalErrorMessage(error, fallbackMessage){
    if(
        error?.response?.status === 400 &&
        error?.response?.data?.error === "invalid_grant"
    ){
        return "Google refresh token has expired or been revoked.";
    }

    if(
        error?.response?.status === 404 &&
        error?.response?.data?.error?.message?.includes("File not found")
    ){
        return "Google Drive folder not found.";
    }

    if(
        error?.response?.status === 403 &&
        error?.response?.data?.error?.message
    ){
        return `Google Drive permission error: ${error.response.data.error.message}`;
    }

    return (
        error?.response?.data?.error?.message ||
        error?.response?.data?.message ||
        error?.errors?.[0]?.message ||
        error?.message ||
        fallbackMessage
    );
}

async function verifyAdmin(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return sendFailure(res, 401, "Unauthorized");
        }

        const token = authHeader.substring(7);
        const decoded = await auth.verifyIdToken(token);

        const email = decoded.email?.toLowerCase();

        if (!email) {
            return sendFailure(res, 401, "Email not found in token");
        }

        const adminDoc = await db
            .collection("admins")
            .doc(email)
            .get();

        if (!adminDoc.exists) {
            return sendFailure(res, 403, "Not an administrator");
        }

        req.user = decoded;
        req.adminData = adminDoc.data();

        next();
    }
    catch (err) {
        console.error(err);

        return sendFailure(res, 401, "Invalid authentication");
    }
}

app.get("/health", (req, res) => {
    res.json({
        success: true,
        status: "running"
    });
});

const uploadEpubFiles=upload.fields([
    {
        name:"cover",
        maxCount:1
    },
    {
        name:"epub",
        maxCount:1
    }
]);

app.post("/upload-epub", verifyAdmin, (req, res) => {
    uploadEpubFiles(req, res, async uploadError => {
        if(uploadError){
            console.error(uploadError);
            return sendFailure(
                res,
                400,
                uploadError.message || "Invalid upload request."
            );
        }

        try{
            const cover=req.files?.cover?.[0];
            const epub=req.files?.epub?.[0];

            if(!cover || !epub){
                return sendFailure(
                    res,
                    400,
                    "Cover and EPUB are required."
                );
            }

            const bookName=requireStringField(req.body.bookName, "book name");
            const authorName=requireStringField(req.body.authorName, "author name");
            const category=requireStringField(req.body.category, "category");
            const language=requireStringField(req.body.language, "language");
            const origin=requireStringField(req.body.origin, "origin");
            const status=requireStringField(req.body.status, "status");
            const description=requireStringField(req.body.description, "description");
            const mainGenre=requireStringField(req.body.mainGenre, "main genre")
                .toLowerCase();
            const chapterNumber=parseIntegerField(
                req.body.chapterNumber,
                "chapter number",
                { min:1 }
            );
            const downloads=parseIntegerField(
                req.body.downloads,
                "downloads",
                {
                    defaultValue:0,
                    min:0
                }
            );
            const views=parseIntegerField(
                req.body.views,
                "views",
                {
                    defaultValue:0,
                    min:0
                }
            );
            const createdAt=parseIntegerField(
                req.body.createdAt,
                "createdAt",
                {
                    defaultValue:Date.now(),
                    min:0
                }
            );
            const updatedAt=parseIntegerField(
                req.body.updatedAt,
                "updatedAt",
                {
                    defaultValue:createdAt,
                    min:0
                }
            );
            const alternateTitles=parseJsonArrayField(
                req.body.alternateTitles,
                "alternateTitles"
            );
            const genres=parseJsonArrayField(
                req.body.genres,
                "genres",
                {
                    lowercase:true
                }
            );
            const tags=parseJsonArrayField(
                req.body.tags,
                "tags",
                {
                    lowercase:true
                }
            );

            if(tags.length === 0){
                throw new Error("At least one tag is required.");
            }

            const baseBookId=normalizeBookId(
                req.body.bookId,
                bookName
            );

            if(!baseBookId){
                throw new Error("Invalid book ID.");
            }

            await validateCover(cover);
            await validateEpub(epub);

            const epubsCollection=db.collection("epubs");
            const finalBookId=await getUniqueBookId(
                epubsCollection,
                baseBookId
            );

            let coverUrl;
            try{
                coverUrl=await uploadToImgBB(cover);
            }
            catch(err){
                throw new Error(
                    `Cover upload failed: ${getExternalErrorMessage(
                        err,
                        "ImgBB upload failed."
                    )}`
                );
            }

            let epubResult;
            try{
                epubResult=await uploadToDrive(
                    epub,
                    BOOKS_FOLDER_ID
                );
            }
            catch(err){
                throw new Error(
                    `EPUB upload failed: ${getExternalErrorMessage(
                        err,
                        "Google Drive upload failed."
                    )}`
                );
            }

            const finalData={
                bookId:finalBookId,
                bookName,
                authorName,
                category,
                chapterNumber,
                description,
                downloads,
                views,
                mainGenre,
                genres,
                alternateTitles,
                language,
                origin,
                status,
                tags,
                createdAt,
                updatedAt,
                uploaderUid:req.user.uid,
                coverUrl,
                epubUrl:epubResult.viewUrl,
                epubDownloadUrl:epubResult.downloadUrl
            };

            const batch=db.batch();
            batch.set(
                epubsCollection.doc(finalBookId),
                finalData
            );
            batch.set(
                epubsCollection.doc("metadata"),
                {
                    browse:{
                        [finalBookId]:buildBrowseEntry(finalData)
                    }
                },
                {
                    merge:true
                }
            );

            await batch.commit();

            return res.json({
                success:true,
                message:"Book uploaded successfully.",
                bookId:finalBookId
            });
        }
        catch(err){
            console.error(err);

            const statusCode=/^(Missing|Invalid|Cover|Corrupted|At least one tag)/.test(
                err.message
            )
                ? 400
                : 500;

            return sendFailure(res, statusCode, err.message);
        }
    });
});

app.post("/create-account", verifyAdmin, async (req, res) => {
    try{
        const uid = req.user?.uid;
        const displayName = (
            req.user?.name ||
            req.user?.displayName ||
            ""
        ).trim();
        const photoURL = req.user?.picture;

        if(!uid){
            return sendFailure(res, 401, "Invalid authentication token.");
        }

        const profileRef = db.collection("userdata").doc(uid);
        const existing = await profileRef.get();

        if(existing.exists){
            return res.json({
                success: true,
                exists: true
            });
        }

        if(!photoURL){
            return sendFailure(res, 400, "Missing profile picture.");
        }

        const avatarResult = await uploadAvatarUrlToImgBB(photoURL, uid);
        const contRef = db.collection("cont").doc(uid);
        const profile = {
            uid,
            username: generateAdminUsername(displayName),
            displayName,
            avatar: avatarResult.avatar,
            banner: null,
            decoration: null,
            owner: false,
            role: "admin",
            createdAt: Date.now()
        };

        try{
            const batch = db.batch();
            batch.create(profileRef, profile);
            batch.set(contRef, {
                avatarDeleteUrl: avatarResult.deleteUrl || null,
                bannerDeleteUrl: null,
                decorationDeleteUrl: null
            });
            await batch.commit();
        }
        catch(err){
            if(
                err?.code === 6 ||
                err?.code === 409 ||
                /already exists/i.test(err?.message || "")
            ){
                return res.json({
                    success: true,
                    exists: true
                });
            }
            throw err;
        }

        return res.json({
            success: true,
            exists: false,
            profile
        });
    }
    catch(err){
        console.error(err);
        return sendFailure(res, 500, err.message);
    }
});

app.post("/save-edited-profile", verifyAdmin, async (req, res) => {
    try{
        const uid = req.user?.uid;
        if(!uid){
            return sendFailure(res, 401, "Invalid authentication token.");
        }

        const profileRef = db.collection("userdata").doc(uid);
        const profileSnap = await profileRef.get();
        if(!profileSnap.exists){
            return sendFailure(res, 404, "Profile not found.");
        }

        const contRef = db.collection("cont").doc(uid);
        const contSnap = await contRef.get();
        const currentDeleteUrls = contSnap.exists ? contSnap.data() || {} : {};

        const updates = {};
        const contUpdates = {};
        const existingProfile = profileSnap.data() || {};

        const displayName = typeof req.body?.displayName === "string"
            ? req.body.displayName.trim()
            : "";
        const username = typeof req.body?.username === "string"
            ? req.body.username.trim()
            : "";

        if(displayName){
            updates.displayName = displayName;
        }

        if(username){
            updates.username = username;
        }

        const editableImages = [
            {
                field: "avatar",
                deleteField: "avatarDeleteUrl",
                data: parseDataUrlImagePayload(req.body?.avatar, "avatar")
            },
            {
                field: "banner",
                deleteField: "bannerDeleteUrl",
                data: parseDataUrlImagePayload(req.body?.banner, "banner")
            },
            {
                field: "decoration",
                deleteField: "decorationDeleteUrl",
                data: parseDataUrlImagePayload(req.body?.decoration, "decoration")
            }
        ];

        const uploadedImages = {};
        for(const item of editableImages){
            if(!item.data){
                continue;
            }

            await validateEditableImage(
                item.data.buffer,
                item.field,
                item.data.mimeType
            );

            const currentDeleteUrl = currentDeleteUrls[item.deleteField] || null;
            if(currentDeleteUrl){
                try{
                    const deleted = await deleteImgBBImage(currentDeleteUrl);
                    if(!deleted){
                        console.warn(
                            `ImgBB deletion returned a non-success response for ${item.field}.`
                        );
                    }
                }
                catch(err){
                    console.warn(
                        `ImgBB deletion failed for ${item.field}:`,
                        err.message || err
                    );
                }
            }

            const uploadResult = await uploadValidatedImageToImgBB(
                item.data.buffer,
                `${uid}-${item.field}`
            );

            uploadedImages[item.field] = uploadResult.imageUrl;
            updates[item.field] = uploadResult.imageUrl;
            contUpdates[item.deleteField] = uploadResult.deleteUrl || null;
        }

        if(
            Object.keys(updates).length === 0 &&
            Object.keys(contUpdates).length === 0
        ){
            return sendFailure(res, 400, "Nothing to save.");
        }

        const batch = db.batch();
        if(Object.keys(updates).length){
            batch.update(profileRef, updates);
        }
        if(Object.keys(contUpdates).length){
            if(!contSnap.exists){
                if(!Object.prototype.hasOwnProperty.call(contUpdates, "avatarDeleteUrl")){
                    contUpdates.avatarDeleteUrl = null;
                }
                if(!Object.prototype.hasOwnProperty.call(contUpdates, "bannerDeleteUrl")){
                    contUpdates.bannerDeleteUrl = null;
                }
                if(!Object.prototype.hasOwnProperty.call(contUpdates, "decorationDeleteUrl")){
                    contUpdates.decorationDeleteUrl = null;
                }
            }
            batch.set(contRef, contUpdates, { merge: true });
        }
        await batch.commit();

        return res.json({
            success: true,
            profile: {
                ...existingProfile,
                ...updates,
                uid
            },
            uploadedImages
        });
    }
    catch(err){
        console.error(err);
        const statusCode = /^(Missing|Invalid|Nothing to save|Profile not found)/.test(
            err.message || ""
        )
            ? 400
            : 500;
        return sendFailure(res, statusCode, err.message);
    }
});

app.post("/delete-account", async (req, res) => {
    try{
        const { idToken } = req.body;
        if(!idToken){
            return sendFailure(res, 401, "Missing authentication token.");
        }
        const decoded = await auth.verifyIdToken(idToken);
        const uid = decoded.uid;
        const email = decoded.email?.toLowerCase();
        if(!uid){
            return sendFailure(res, 401, "Invalid authentication token.");
        }

        const contRef = db.collection("cont").doc(uid);
        const contSnap = await contRef.get();
        const userDeleteUrls = contSnap.exists ? contSnap.data() : null;
        const avatarDeleteUrl = userDeleteUrls?.avatarDeleteUrl || null;
        const bannerDeleteUrl = userDeleteUrls?.bannerDeleteUrl || null;
        const decorationDeleteUrl = userDeleteUrls?.decorationDeleteUrl || null;

        const urlsToDelete = [
            avatarDeleteUrl,
            bannerDeleteUrl,
            decorationDeleteUrl
        ].filter(Boolean);
        let imageDeleted = urlsToDelete.length === 0;
        try{
            const deleteResults = await Promise.allSettled(
                urlsToDelete.map(deleteImgBBImage)
            );
            imageDeleted = deleteResults.every(result =>
                result.status === "fulfilled" ? result.value === true : false
            );
        }
        catch(err){
            console.warn("ImgBB image deletion failed:", err.message || err);
        }

        await db.collection("userdata").doc(uid).delete();
        if(contSnap.exists){
            await contRef.delete();
        }
        if(email){
            await db.collection("admins").doc(email).delete();
        }
        await auth.deleteUser(uid);
        return res.json({
            success: true,
            message: "Account deleted successfully.",
            imageDeleted
        });
    }
    catch(err){
        console.error(err);
        return sendFailure(
            res,
            401,
            "Invalid or expired authentication token."
        );
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log("==================================");
    console.log(" Immortal Library Backend Running ");
    console.log(` http://localhost:${PORT}`);
    console.log("==================================");
});
