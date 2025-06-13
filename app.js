require("dotenv").config();
const express = require("express");
const {engine} = require("express-handlebars");
const connectDB = require("./service/database.js")
const adminRoutes = require("./routes/adminRoutes.js")
const methodOverride = require("method-override")
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// override with POST having ?_method=DELETE
app.use(methodOverride('_method'));

//set template engine
app.engine("hbs",engine({extname:".hbs",layoutDir:"views/layouts/",defaultLayout:"main-layout"}));
app.set("view engine","hbs");
app.set("views","views");

//db connect
connectDB()

app.use("/",adminRoutes);
const hubspotListRoutes = require('./routes/hubspotRoute.js');
app.use('/api', hubspotListRoutes);

app.listen(process.env.PORT,()=>{
    console.log("server running on http://localhost:8000/");
})