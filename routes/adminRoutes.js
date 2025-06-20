const express = require("express");
const router = express.Router();
const Segmentation = require("../models/segmentation");
const CreatedList = require("../models/list");

router.post("/add-email", async (req, res) => {
  try {
    const newEmail = new Segmentation(req.body);
    await newEmail
      .save()
      .then((savedEmail) => {
        console.log("saved:", savedEmail);
        res.status(200).redirect("/");
      })
      .catch((error) => {
        console.log(error);
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "unable to create new Email" });
  }
});


//read all emails
router.get("/", async (req, res) => {
  try {
    // CreatedList.find().then((list)=> console.log(list))
   const now = new Date();
const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const endOfDay = new Date(startOfDay);
endOfDay.setUTCDate(startOfDay.getUTCDate() + 1);

const lists = await CreatedList.find({
  createdDate: {
    $gte: startOfDay,
    $lt: endOfDay
  }
}).sort({ createdDate: -1 }).lean();
    await Segmentation.find().sort({ order: 1 }).lean()
      .then((emails) => {
        //  console.log(emails);
        res
          .status(200)
          .render("index", {
            emails: JSON.parse(JSON.stringify(emails)),
            hasEmails: emails.length > 0,
            lists: JSON.parse(JSON.stringify(lists)),
            hasLists: lists.length > 0,
            isEdit:false,
            pageTitle: "create list",
            activePage:"create list",
          });
      })
      .catch((error) => {
        console.log(error);
        res.status(500).json({ msg: "Unable to get emails" });
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to get emails" });
  }
});

//  Update functionality
router.put("/email/:id/edit", async (req, res) => {
  try {
    const id = req.params.id;
    const updatedEmail = req.body;
    await Segmentation.findOneAndUpdate({ _id: id }, updatedEmail, {
      new: true,
    })
      .then((updatedEmail) => {
        console.log("updated:",updatedEmail);
        res.redirect("/");
      })
      .catch((error) => {
        console.log(error);
        res.status(500).json({ msg: "Unable to update the contact" });
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to update the contact" });
  }
});

//  Delete
router.delete("/email/:id", async (req, res) => {
  try {
    const id = req.params.id;
    // validation ...
    await Segmentation.findByIdAndDelete(id)
      .then((deletedEmail) => {
        console.log("deleted", deletedEmail);
        res.redirect("/"); // redirect after deletion
        //  res.status(200).json({email:deletedEmail, msg:"Email deleted succesfully"});
      })
      .catch((error) => {
        console.log(error);
        res.status(500).json({ msg: "Unable to delete the email" });
      });
  } catch (error) {
    console.log(error);
    res.status(500).json({ msg: "Unable to delete the email" });
  }
});




/// others 
//segmentation reorder
router.post('/api/segmentations/reorder', async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ success: false, message: "Invalid input" });
  }

  try {
    const bulkOps = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { order: index } }
      }
    }));

    await Segmentation.bulkWrite(bulkOps);
    res.json({ success: true });
  } catch (err) {
    console.error("Reorder failed:", err);
    res.status(500).json({ success: false });
  }
});



//docs page
router.get('/docs', async (req, res) => {
  try{
    res.render("docs",{
       pageTitle: "docs",
      activePage:"docs",
    })
  } catch (err) {
    console.error("Reorder failed:", err);
    res.status(500).json({ success: false });
  }
});



module.exports = router;


