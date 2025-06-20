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


app.engine("hbs",engine({extname:".hbs",layoutDir:"views/layouts/",defaultLayout:"main-layout", 
    helpers: {
      isActive: function (activePage, currentPage, options) {
        return activePage === currentPage ? "active" : "";
      },
      isType: function (isMain, currentType, options) {
        isMain = currentType.toLowerCase().includes("main");
        return isMain ? "mainStyle" : "subStyle";
      }
    },}));
app.set("view engine","hbs");
app.set("views","views");

//db connect
connectDB()

app.use("/",adminRoutes);
const hubspotListRoutes = require('./routes/hubspotRoute.js');
app.use('/api', hubspotListRoutes);

const ClonerRoutes = require('./routes/cloner.js');
app.use('/api', ClonerRoutes);

app.listen(process.env.PORT,()=>{
    console.log("server running on http://localhost:8000/");
})