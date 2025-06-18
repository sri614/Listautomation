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
    Segmentation.find()
      .then((emails) => {
        // console.log(emails);
        res
          .status(200)
          .render("index", {
            emails: JSON.parse(JSON.stringify(emails)),
            hasEmails: emails.length > 0,
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
        console.log(updatedEmail);
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

//  Delete functionality
// 2types
// soft delete => update the field "active" -> Y/N
// hard delete => deletion of record/document
router.delete("/email/:id", async (req, res) => {
  try {
    const id = req.params.id;
    // validation ...
    await Segmentation.findByIdAndDelete(id)
      .then((deletedEmail) => {
        console.log("dlt", deletedEmail);
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




module.exports = router;


