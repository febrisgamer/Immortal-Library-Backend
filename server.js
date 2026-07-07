const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
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
        "https://immortal-library.firebaseapp.com"
    ]
}));
app.use(express.json());

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024
    }
});

const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const drive = google.drive({version:"v3", auth:oauth2Client});

/*
Immortal Library
└── Books
*/

const BOOKS_FOLDER_ID = "1ZBFaiY2pORDGrf8UB4DsgjnkoBCedFPS";

app.get("/", (req, res) => {
    res.send("Immortal Library Backend Running");
});

async function uploadToDrive(file, folderId){
    const tempPath = path.join(
        __dirname,
        "temp-" + Date.now() + "-" + file.originalname
    );
    fs.writeFileSync(
        tempPath,
        file.buffer
    );
    try{
        const response = await drive.files.create({
            requestBody:{
                name:file.originalname,
                parents:[folderId]
            },
            media:{
                mimeType:file.mimetype,
                body:fs.createReadStream(tempPath)
            },
            fields:"id,name"
        });

        fs.unlinkSync(tempPath);
        await drive.permissions.create({
            fileId:response.data.id,
            requestBody:{
                role:"reader",
                type:"anyone"
            }
        });
        const fileId = response.data.id;
        return{
            fileId,
            downloadUrl:
                `https://drive.google.com/uc?export=download&id=${fileId}`,
            viewUrl:
                `https://drive.google.com/file/d/${fileId}/view`,
            imageUrl:
                `https://lh3.googleusercontent.com/d/${fileId}=w2000-h2000`
        };
    }
    finally{
        if(fs.existsSync(tempPath)){
            fs.unlinkSync(tempPath);
        }
    }
}

async function uploadToImgBB(file) {
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
            maxBodyLength: Infinity
        }
    );
    const data = response.data.data;
    return {
        id: data.id,
        deleteUrl: data.delete_url,
        imageUrl: data.url,
        displayUrl: data.display_url,
        viewerUrl: data.url_viewer,
        thumbUrl: data.thumb.url,
        mediumUrl: data.medium
            ? data.medium.url
            : data.display_url
    };
}

async function uploadAvatarUrlToImgBB(photoUrl, fileName) {
    const imageResponse = await axios.get(photoUrl, {
        responseType: "arraybuffer"
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
        avatar: response.data.data.url
    };
}

async function verifyAdmin(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                error: "Unauthorized"
            });
        }
        const token = authHeader.split("Bearer ")[1];
        const decoded = await auth.verifyIdToken(token);
        const adminDoc = await db
            .collection("admins")
            .doc(decoded.email)
            .get();
        if (!adminDoc.exists) {
            return res.status(403).json({
                success: false,
                error: "Not an administrator"
            });
        }
        const data = adminDoc.data();
        if (data.uid !== decoded.uid) {
            return res.status(403).json({
                success: false,
                error: "UID mismatch"
            });
        }
        req.user = decoded;
        req.adminData = data;
        next();
    }
    catch (err) {
        console.error(err);
        return res.status(401).json({
            success: false,
            error: "Invalid authentication"
        });
    }
}

app.get("/health", (req, res) => {
    res.json({
        success: true,
        status: "running"
    });
});

app.post(
    "/upload",
    verifyAdmin,
    upload.fields([
        {
            name:"cover",
            maxCount:1
        },
        {
            name:"epub",
            maxCount:1
        }
    ]),
    async(req,res)=>{
        try{
            const cover =
                req.files?.cover?.[0];
            const epub =
                req.files?.epub?.[0];
            if(!cover || !epub){
                return res.status(400).json({
                    success:false,
                    error:"Cover and EPUB are required."
                });
            }
            const metadata =
                req.body.metadata
                    ? JSON.parse(req.body.metadata)
                    : {};
            const coverResult =
                await uploadToImgBB(
                    cover
                );
            const epubResult =
                await uploadToDrive(
                    epub,
                    BOOKS_FOLDER_ID
                );
            res.json({
                success:true,
                metadata,
                cover:coverResult,
                epub:epubResult
            });
        }
        catch(err){
            console.error(err);
            res.status(500).json({
                success:false,
                error:err.message
            });
        }
    }
);

app.post("/upload-avatar", verifyAdmin, async (req, res) => {
    try {
        const { photoURL, uid } = req.body;
        if (!photoURL) {
            return res.status(400).json({
                success: false,
                error: "Missing photoURL"
            });
        }
        const avatar = await uploadAvatarUrlToImgBB(
            photoURL,
            uid || "avatar"
        );
        res.json({
            success: true,
            avatar: avatar.avatar
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log("==================================");
    console.log(" Immortal Library Backend Running ");
    console.log(` http://localhost:${PORT}`);
    console.log("==================================");
});
